import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { ThemeService } from '../../core/theme';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';

export function languageFor(path: string): Extension {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'html':
    case 'htm':
      return html();
    case 'css':
      return css();
    case 'json':
    case 'jsonc':
      return json();
    case 'py':
      return python();
    case 'php':
      return php();
    case 'md':
    case 'markdown':
      return markdown();
    default:
      return [];
  }
}

@Component({
  selector: 'app-code-editor',
  template: `<div
    #host
    class="min-h-80 overflow-hidden border border-rule text-sm"
    data-testid="code-editor"
  ></div>`,
})
export class CodeEditor {
  readonly path = input.required<string>();
  readonly value = input.required<string>();
  readonly readonly = input(false);
  readonly changed = output<string>();
  readonly save = output<void>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  #view: EditorView | null = null;
  readonly #language = new Compartment();
  readonly #editable = new Compartment();
  readonly #dark = new Compartment();
  readonly #theme = inject(ThemeService);
  #shownPath: string | null = null;

  constructor() {
    afterNextRender(() => {
      this.#view = new EditorView({ parent: this.host().nativeElement, state: this.#state() });
      this.#shownPath = this.path();
    });
    inject(DestroyRef).onDestroy(() => this.#view?.destroy());

    effect(() => {
      const dark = this.#theme.dark();
      untracked(() =>
        this.#view?.dispatch({ effects: this.#dark.reconfigure(dark ? oneDark : []) }),
      );
    });

    effect(() => {
      const path = this.path(),
        value = this.value(),
        ro = this.readonly();
      untracked(() => {
        const view = this.#view;
        if (!view) return;
        if (path !== this.#shownPath) {
          view.setState(this.#state());
          this.#shownPath = path;
          return;
        }
        if (view.state.doc.toString() !== value)
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
        view.dispatch({ effects: this.#editable.reconfigure(EditorView.editable.of(!ro)) });
      });
    });
  }

  #state(): EditorState {
    return EditorState.create({
      doc: this.value(),
      extensions: [
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              this.save.emit();
              return true;
            },
          },
        ]),
        basicSetup,
        this.#language.of(languageFor(this.path())),
        this.#editable.of(EditorView.editable.of(!this.readonly())),
        EditorView.lineWrapping,
        this.#dark.of(this.#theme.dark() ? oneDark : []),
        EditorView.theme({
          '&': { height: '28rem', backgroundColor: 'var(--gw-surface)', color: 'var(--gw-ink)' },
          '.cm-gutters': {
            backgroundColor: 'var(--gw-paper)',
            color: 'var(--gw-muted)',
            borderRight: '1px solid var(--gw-rule)',
          },
          '.cm-scroller': { fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, monospace" },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.changed.emit(u.state.doc.toString());
        }),
      ],
    });
  }
}
