import {
  deleteTripExpenses,
  loadTrips,
  saveTrips,
  type LocalTrip,
} from "./runtime";

export type TripDeletionResult = {
  remainingTrips: LocalTrip[];
  removedExpenseCount: number;
};

/**
 * Bills are removed first. The local itinerary is only removed after the
 * billing service confirms its atomic trip-level delete, so bill rows cannot
 * be orphaned by a successful local delete.
 */
export async function deleteTripAndBills(
  tripId: string,
): Promise<TripDeletionResult> {
  const removedExpenseCount = await deleteTripExpenses(tripId);
  const remainingTrips = loadTrips().filter((trip) => trip.id !== tripId);
  saveTrips(remainingTrips);
  return { remainingTrips, removedExpenseCount };
}
