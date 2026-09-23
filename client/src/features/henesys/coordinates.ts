/** TMS273 map coordinates remain authoritative; Blender/glTF are metre-scaled views. */
export const HENESYS_MAP_ID = '100000000';
export const PIXELS_PER_METRE = 45;
export const PAPER_DEPTH = 4.2;
export const point3d = (x: number, y: number): [number, number, number] => [(x - 3285) / PIXELS_PER_METRE, (450 - y) / PIXELS_PER_METRE, PAPER_DEPTH];
export const sourcePoint = (x: number, y: number) => ({ x: x * PIXELS_PER_METRE + 3285, y: 450 - y * PIXELS_PER_METRE });
