import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const hotels = sqliteTable("hotels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  area: text("area").notNull(),
  address: text("address").notNull(),
  stars: integer("stars").notNull(),
  rating: integer("rating").notNull(),
  description: text("description").notNull(),
  accent: text("accent").notNull(),
  distance: text("distance").notNull(),
  amenities: text("amenities").notNull(),
});

export const dailyInventory = sqliteTable(
  "daily_inventory",
  {
    hotelId: text("hotel_id").notNull(),
    stayDate: text("stay_date").notNull(),
    roomName: text("room_name").notNull(),
    price: integer("price").notNull(),
    availableRooms: integer("available_rooms").notNull(),
    status: text("status").notNull().default("OPEN"),
  },
  (table) => [primaryKey({ columns: [table.hotelId, table.stayDate] })],
);

export const bookings = sqliteTable("bookings", {
  id: text("id").primaryKey(),
  confirmationNo: text("confirmation_no").notNull().unique(),
  hotelId: text("hotel_id").notNull(),
  userId: text("user_id").notNull(),
  checkIn: text("check_in").notNull(),
  checkOut: text("check_out").notNull(),
  roomName: text("room_name").notNull(),
  guests: integer("guests").notNull(),
  rooms: integer("rooms").notNull(),
  status: text("status").notNull(),
  quoteVersion: integer("quote_version").notNull(),
  totalAmount: integer("total_amount").notNull(),
  createdAt: text("created_at").notNull(),
});

export const bills = sqliteTable("bills", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle").notNull(),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(),
  dueAt: text("due_at").notNull(),
  version: integer("version").notNull(),
  breakdown: text("breakdown").notNull(),
  createdAt: text("created_at").notNull(),
});

export const paymentAuthorizations = sqliteTable("payment_authorizations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  agentName: text("agent_name").notNull(),
  billIds: text("bill_ids").notNull(),
  maxAmount: integer("max_amount").notNull(),
  currency: text("currency").notNull(),
  quoteVersions: text("quote_versions").notNull(),
  status: text("status").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const bookingQuotes = sqliteTable("booking_quotes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  hotelId: text("hotel_id").notNull(),
  checkIn: text("check_in").notNull(),
  checkOut: text("check_out").notNull(),
  guests: integer("guests").notNull(),
  rooms: integer("rooms").notNull(),
  roomName: text("room_name").notNull(),
  roomTotal: integer("room_total").notNull(),
  serviceFee: integer("service_fee").notNull(),
  totalAmount: integer("total_amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const billAdjustmentQuotes = sqliteTable("bill_adjustment_quotes", {
  id: text("id").primaryKey(),
  billId: text("bill_id").notNull(),
  userId: text("user_id").notNull(),
  baseVersion: integer("base_version").notNull(),
  breakfast: integer("breakfast", { mode: "boolean" }).notNull(),
  newAmount: integer("new_amount").notNull(),
  newBreakdown: text("new_breakdown").notNull(),
  status: text("status").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const activities = sqliteTable("activities", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(),
  message: text("message").notNull(),
  createdAt: text("created_at").notNull(),
});
