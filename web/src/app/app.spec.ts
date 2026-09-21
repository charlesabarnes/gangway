import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Home } from './home';

describe('Home', () => {
  const render = async (respond: (http: HttpTestingController) => void) => {
    TestBed.configureTestingModule({ imports: [Home], providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    const fixture = TestBed.createComponent(Home);
    fixture.detectChanges();
    respond(TestBed.inject(HttpTestingController));
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const text = (id: string) => el.querySelector(`[data-testid="${id}"]`)?.textContent?.trim();
    return { status: text('status'), routes: text('routes') };
  };

  it('shows a serving server and its route count', async () => {
    expect(await render((http) => http.expectOne('/healthz').flush({ ok: true, routes: 3 }))).toEqual({ status: 'serving', routes: '3' });
  });

  it('tells a draining server (503) from one that is gone', async () => {
    expect(await render((http) => http.expectOne('/healthz').flush({ ok: false, draining: true }, { status: 503, statusText: 'x' }))).toEqual({ status: 'shutting down', routes: '—' });
    TestBed.resetTestingModule();
    expect(await render((http) => http.expectOne('/healthz').error(new ProgressEvent('error')))).toEqual({ status: 'unreachable', routes: '—' });
  });
});
