import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';

/** A preview's own URL, which the server hands out, trusted as a frame source. Only https. */
@Pipe({ name: 'safeFrame' })
export class SafeFramePipe implements PipeTransform {
  readonly #sanitizer = inject(DomSanitizer);
  transform(url: string): SafeResourceUrl | null {
    return /^https:\/\//.test(url) ? this.#sanitizer.bypassSecurityTrustResourceUrl(url) : null;
  }
}
