import { loadTrips, saveTrips, type LocalTrip } from "./runtime";

function renameMatchingMarkdownHeading(
  content: string,
  previousTitle: string,
  nextTitle: string,
): string {
  const separator = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => {
    const match = line.match(/^\s*#\s+(.+?)\s*$/);
    return match?.[1].trim() === previousTitle.trim();
  });
  if (headingIndex < 0) return content;

  const indentation = lines[headingIndex].match(/^(\s*)/)?.[1] || "";
  lines[headingIndex] = `${indentation}# ${nextTitle}`;
  return lines.join(separator);
}

/**
 * Rename the shared local trip record used by both the journey and bills pages.
 * Keeping the trip id unchanged preserves every bill association, while
 * saveTrips broadcasts the existing trip-change event to both pages.
 */
export function renameTrip(tripId: string, title: string): LocalTrip {
  const nextTitle = title.trim();
  if (!nextTitle) throw new Error("请输入行程名称");

  const trips = loadTrips();
  const tripIndex = trips.findIndex((trip) => trip.id === tripId);
  if (tripIndex < 0) throw new Error("找不到要重命名的行程");

  const updatedTrip: LocalTrip = {
    ...trips[tripIndex],
    title: nextTitle,
    content: renameMatchingMarkdownHeading(
      trips[tripIndex].content,
      trips[tripIndex].title,
      nextTitle,
    ),
    updatedAt: Date.now(),
  };
  const nextTrips = trips.map((trip, index) =>
    index === tripIndex ? updatedTrip : trip,
  );
  saveTrips(nextTrips);
  return updatedTrip;
}
