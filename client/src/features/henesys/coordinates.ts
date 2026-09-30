/** x is distance along the rail, y is height in source pixels. No client prediction. */
import rail from '../../../../shared/henesys-rail.json';
export const HENESYS_MAP_ID = rail.mapId;
export const PIXELS_PER_METRE = rail.pixelsPerMetre;
export const PAPER_DEPTH = rail.paperDepth;
export const RAIL_RADIUS = rail.radius;
export const platformThickness = (id: number) => rail.decks.some(d => d.id === id) ? rail.deckThickness : rail.platformThickness;
export const railAngle = (x: number) => (x - rail.originX) / (PIXELS_PER_METRE * RAIL_RADIUS);
export const point3d = (x: number, y: number, depth = 0): [number, number, number] => {
  const angle = railAngle(x), radius = RAIL_RADIUS - depth;
  return [radius * Math.sin(angle), (rail.originY - y) / PIXELS_PER_METRE, PAPER_DEPTH + RAIL_RADIUS - radius * Math.cos(angle)];
};
export const sourcePoint = (x: number, y: number, z: number) => ({
  x: Math.atan2(x, RAIL_RADIUS + PAPER_DEPTH - z) * RAIL_RADIUS * PIXELS_PER_METRE + rail.originX,
  y: rail.originY - y * PIXELS_PER_METRE,
});
