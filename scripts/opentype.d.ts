declare module "opentype.js" {
  interface Path {
    toPathData(decimalPlaces?: number): string;
  }
  interface Glyph {
    advanceWidth?: number;
    getPath(x: number, y: number, fontSize: number): Path;
  }
  interface Font {
    unitsPerEm: number;
    stringToGlyphs(text: string): Glyph[];
    getKerningValue(left: Glyph, right: Glyph): number;
  }
  function parse(buffer: ArrayBuffer): Font;
  export default { parse };
  export type { Font, Glyph };
}
