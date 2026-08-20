export type ExifResult = Record<string, unknown> & {
  latitude?: number;
  longitude?: number;
  DateTimeOriginal?: Date | string;
  CreateDate?: Date | string;
  DateTime?: Date | string;
  City?: string;
  State?: string;
  Country?: string;
  CountryCode?: string;
  Sublocation?: string;
  GPSAreaInformation?: string;
};

export function parse(
  input: Blob | ArrayBuffer | Uint8Array | string,
  options?: Record<string, unknown>,
): Promise<ExifResult | undefined>;

