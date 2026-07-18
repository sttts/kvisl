export const SIDES = ["top", "right", "bottom", "left"];

export function rotateSide(side, degrees) {
  if (!SIDES.includes(side)) return side;
  const turns = ((degrees % 360) + 360) % 360 / 90;
  return SIDES[(SIDES.indexOf(side) + turns) % 4];
}

export function absoluteOrientation(object) {
  let orientation = 0;
  for (let current = object; current; current = current.parent) orientation += current.orientation ?? 0;
  return ((orientation % 360) + 360) % 360;
}
