/**
 * jsdom has no <dialog> behaviour: no showModal(), no close(). Every browser gangway
 * supports does, so the component calls them directly and SPECS get the minimum that makes
 * them observable -- the `open` attribute, `returnValue`, and the `close` event.
 * Focus trapping, Esc and the inert backdrop are the browser's and are not faked here.
 */
export function installDialogPolyfill(): void {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { __polyfilled?: boolean };
  if (proto.__polyfilled || typeof proto.showModal === 'function') return;
  proto.__polyfilled = true;
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.show = proto.showModal;
  proto.close = function (this: HTMLDialogElement, value?: string) {
    if (!this.hasAttribute('open')) return;
    if (value !== undefined) this.returnValue = value;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
