import {
  listTripExpenses,
  updateTripExpense,
  type TripExpense,
  type TripExpenseInput,
  type TripStop,
} from "./runtime";

export type LinkedExpenseUpdate = {
  expense: TripExpense;
  input: TripExpenseInput;
};

function normalizedPlaceName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

function expenseInput(
  expense: TripExpense,
  placeName = expense.place_name,
  day = expense.day,
  title = expense.title,
): TripExpenseInput {
  return {
    title,
    category: expense.category,
    placeName,
    day,
    unitAmount: expense.unit_amount,
    quantity: expense.quantity,
    required: expense.required,
    note: expense.note,
  };
}

export function linkedExpenseUpdates(
  expenses: TripExpense[],
  previousStops: TripStop[],
  nextStops: TripStop[],
): LinkedExpenseUpdate[] {
  const nextById = new Map(nextStops.map((stop) => [stop.id, stop]));
  const claimedExpenses = new Set<string>();
  const updates: LinkedExpenseUpdate[] = [];

  for (const previousStop of previousStops) {
    const nextStop = nextById.get(previousStop.id);
    if (!nextStop) continue;

    const previousDay = previousStop.day || 1;
    const nextDay = nextStop.day || 1;
    const placeChanged =
      normalizedPlaceName(previousStop.name) !==
      normalizedPlaceName(nextStop.name);
    if (!placeChanged && previousDay === nextDay) continue;

    for (const expense of expenses) {
      if (claimedExpenses.has(expense.id)) continue;
      const matchedByPlace =
        normalizedPlaceName(expense.place_name) ===
        normalizedPlaceName(previousStop.name);
      const matchedByTitle =
        !expense.place_name.trim() &&
        normalizedPlaceName(expense.title) ===
          normalizedPlaceName(previousStop.name);
      if (!matchedByPlace && !matchedByTitle) continue;
      if (expense.day !== null && expense.day !== previousDay) continue;

      claimedExpenses.add(expense.id);
      updates.push({
        expense,
        input: expenseInput(
          expense,
          nextStop.name,
          nextDay,
          matchedByTitle ? nextStop.name : expense.title,
        ),
      });
    }
  }

  return updates;
}

export function buildEditedTripMarkdown(
  title: string,
  stops: TripStop[],
): string {
  const sections = new Map<number, TripStop[]>();
  for (const stop of stops) {
    const day = stop.day || 1;
    sections.set(day, [...(sections.get(day) || []), stop]);
  }

  const lines = [`# ${title.trim()}`, ""];
  for (const [day, dayStops] of [...sections.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    lines.push(`## 第 ${day} 天`, "");
    for (const stop of dayStops) {
      const time = stop.time?.trim() || "时间待定";
      lines.push(`- **${time}｜${stop.name.trim()}**`);
      if (stop.note?.trim()) lines.push(`  - ${stop.note.trim()}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

/**
 * Update linked bills before the caller saves the local trip. Completed bill
 * writes are rolled back when a later write fails, keeping both views aligned.
 */
export async function syncTripExpensesForStops(
  tripId: string,
  previousStops: TripStop[],
  nextStops: TripStop[],
): Promise<number> {
  const previousById = new Map(previousStops.map((stop) => [stop.id, stop]));
  const hasBillRelevantChange = nextStops.some((stop) => {
    const previous = previousById.get(stop.id);
    return (
      previous &&
      (normalizedPlaceName(previous.name) !== normalizedPlaceName(stop.name) ||
        (previous.day || 1) !== (stop.day || 1))
    );
  });
  if (!hasBillRelevantChange) return 0;

  const { expenses } = await listTripExpenses(tripId);
  const updates = linkedExpenseUpdates(expenses, previousStops, nextStops);
  const completed: LinkedExpenseUpdate[] = [];

  try {
    for (const update of updates) {
      await updateTripExpense(update.expense.id, update.input);
      completed.push(update);
    }
  } catch (error) {
    const rollbackResults = await Promise.allSettled(
      completed
        .reverse()
        .map((update) =>
          updateTripExpense(update.expense.id, expenseInput(update.expense)),
        ),
    );
    if (rollbackResults.some((result) => result.status === "rejected")) {
      throw new Error(
        `账单同步失败，且部分账单未能自动恢复：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    throw error;
  }

  return updates.length;
}
