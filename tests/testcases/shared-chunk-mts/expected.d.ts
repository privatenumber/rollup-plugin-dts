// entry-a.d.mts
declare class Shared {
  value: string;
}
declare const a: Shared;
export { Shared, a };
// entry-b.d.mts
import { Shared } from './entry-a.mjs';
declare const b: Shared;
export { Shared, b };
