// entry-a.d.ts
declare class Shared {
  private _id: string;
  get id(): string;
}
declare const a: Shared;
export { Shared, a };
// entry-b.d.ts
import { Shared } from './entry-a.js';
declare function accept(s: Shared): void;
export { Shared, accept };
