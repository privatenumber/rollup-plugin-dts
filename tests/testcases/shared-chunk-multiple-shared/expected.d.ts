// entry-a.d.ts
declare class X {
  x: number;
}
declare class Y {
  y: number;
}
declare const a: X & Y;
export { X, Y, a };
// entry-b.d.ts
import { X, Y } from './entry-a.js';
declare const b: X | Y;
export { X, Y, b };
