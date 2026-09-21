import { provideHttpClient, withInterceptors, type HttpInterceptorFn } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type Provider, type EnvironmentProviders, type Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, type Routes } from '@angular/router';

export type Rendered<T> = {
  fixture: ComponentFixture<T>;
  http: HttpTestingController;
  el: HTMLElement;
  /** Let pending microtasks, signals and the zoneless scheduler settle, then re-render. */
  settle(): Promise<void>;
  byTestId(id: string): HTMLElement | null;
  allByTestId(id: string): HTMLElement[];
  text(id: string): string | undefined;
};

export type RenderOptions = {
  providers?: (Provider | EnvironmentProviders)[];
  routes?: Routes;
  interceptors?: HttpInterceptorFn[];
  inputs?: Record<string, unknown>;
};

/** The pattern every component spec here starts with. Zoneless: nothing re-renders until asked. */
export async function render<T>(component: Type<T>, o: RenderOptions = {}): Promise<Rendered<T>> {
  TestBed.configureTestingModule({
    imports: [component],
    providers: [provideRouter(o.routes ?? []), provideHttpClient(withInterceptors(o.interceptors ?? [])), provideHttpClientTesting(), ...(o.providers ?? [])],
  });
  const fixture = TestBed.createComponent(component);
  for (const [k, v] of Object.entries(o.inputs ?? {})) fixture.componentRef.setInput(k, v);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  await settle();
  const allByTestId = (id: string) => Array.from(el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
  return {
    fixture, el, settle, allByTestId,
    http: TestBed.inject(HttpTestingController),
    byTestId: (id) => allByTestId(id)[0] ?? null,
    text: (id) => allByTestId(id)[0]?.textContent?.replace(/\s+/g, ' ').trim(),
  };
}
