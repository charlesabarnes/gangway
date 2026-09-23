import { provideHttpClient, withInterceptors, type HttpInterceptorFn } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type Provider, type EnvironmentProviders, type Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, type Routes } from '@angular/router';

export type Rendered<T> = {
  fixture: ComponentFixture<T>;
  http: HttpTestingController;
  el: HTMLElement;
  settle(): Promise<void>;
  until(done: () => boolean, what?: string): Promise<void>;
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

export async function render<T>(component: Type<T>, o: RenderOptions = {}): Promise<Rendered<T>> {
  TestBed.configureTestingModule({
    imports: [component],
    providers: [
      provideRouter(o.routes ?? []),
      provideHttpClient(withInterceptors(o.interceptors ?? [])),
      provideHttpClientTesting(),
      ...(o.providers ?? []),
    ],
  });
  const fixture = TestBed.createComponent(component);
  for (const [k, v] of Object.entries(o.inputs ?? {})) fixture.componentRef.setInput(k, v);
  const el = fixture.nativeElement as HTMLElement;
  // Real setTimeout: specs that fake timers fake only setInterval.
  const turn = () => new Promise<void>((r) => setTimeout(r));
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await turn();
    }
    fixture.detectChanges();
  };
  const until = async (done: () => boolean, what = 'condition') => {
    for (let i = 0; i < 100; i++) {
      if (done()) return;
      await settle();
    }
    throw new Error(`gave up waiting for: ${what}`);
  };
  await settle();
  const allByTestId = (id: string) =>
    Array.from(el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
  return {
    fixture,
    el,
    settle,
    until,
    allByTestId,
    http: TestBed.inject(HttpTestingController),
    byTestId: (id) => allByTestId(id)[0] ?? null,
    text: (id) => allByTestId(id)[0]?.textContent?.replace(/\s+/g, ' ').trim(),
  };
}
