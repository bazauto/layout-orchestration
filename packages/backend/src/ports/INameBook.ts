/**
 * Port: INameBook
 *
 * A cache of the current `NameBook` for one layout (#54, see
 * `docs/naming.md`). Implemented by `services/nameBook.ts#NameBookCache`;
 * `LayoutService`, `ReservationService`, and `TopologyService` each take one
 * by injection so a searched name never requires a service to reach into
 * another (`LayoutService → ReservationService` is one-way and
 * `TopologyService` takes no service references — see D4).
 */

import { LayoutId, NameBook } from '../domain/types';

export interface INameBook {
  /** The most recently built book, or `EMPTY_NAME_BOOK` before the first `refresh`. */
  get(): NameBook;
  /** Rebuilds the book from the repository. A documented no-op when `layoutId` does not match the bound layout (D5). */
  refresh(layoutId: LayoutId): Promise<void>;
}
