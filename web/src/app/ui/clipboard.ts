import { Injectable, inject } from '@angular/core';
import { ToastService } from './toast';

export type ToastText = readonly [title: string, detail?: string];

@Injectable({ providedIn: 'root' })
export class ClipboardService {
  readonly #toasts = inject(ToastService);

  async write(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async copy(text: string, copied: ToastText, refused: ToastText): Promise<void> {
    const [title, detail] = (await this.write(text)) ? copied : refused;
    this.#toasts.info(title, detail);
  }
}
