/**
 * Structured representation of a parsed GRIB2 message. All fields are parsed
 * eagerly except Section 7 (data), which is kept as a raw byte slice and
 * decoded on demand via unpack().
 */
export {};
