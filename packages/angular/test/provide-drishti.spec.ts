import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { DRISHTI, provideDrishti } from '../src/public-api';

@Component({ selector: 'dk-empty', template: '' })
class EmptyComponent {}

@Component({ selector: 'dk-root', template: '' })
class RootComponent {}

type FetchMock = jest.Mock<Promise<unknown>, [string, RequestInit]>;

function setup(fetchMock: FetchMock, headers?: () => () => Record<string, string>): Router {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: '', component: RootComponent },
        { path: 'items/:id', component: EmptyComponent },
        { path: 'teams', component: EmptyComponent, children: [{ path: ':teamId/members', component: EmptyComponent }] },
      ]),
      provideDrishti({ endpoint: '/api/drishti/events', version: '1.2.3', fetch: fetchMock, headers }),
    ],
  });
  return TestBed.inject(Router);
}

describe('provideDrishti', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('records a screen with the route pattern, never the URL', async () => {
    const fetchMock: FetchMock = jest.fn(async (_url: string, _init: RequestInit) => ({ ok: true }));
    const router = setup(fetchMock);
    await router.navigateByUrl('/items/42?secret=abc#frag');
    await router.navigateByUrl('/teams/7/members');
    await router.navigateByUrl('/');
    await TestBed.inject(DRISHTI).flush();
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body as string) as { v: string; ev: Array<{ k: string; n: string }> };
    expect(body.v).toBe('1.2.3');
    expect(body.ev.map((e) => [e.k, e.n])).toEqual([
      ['screen', 'items/:id'],
      ['screen', 'teams/:teamId/members'],
      ['screen', '/'],
    ]);
    // The times ("t") are clock numbers and can hold "42", so they are taken out before the check.
    const text = fetchMock.mock.calls
      .map(([, init]) => init.body as string)
      .join('')
      .replace(/"t":\d+/g, '');
    expect(text).not.toContain('42');
    expect(text).not.toContain('secret');
  });

  it('runs the headers factory once, in an injection context', async () => {
    const fetchMock: FetchMock = jest.fn(async (_url: string, _init: RequestInit) => ({ ok: true }));
    let factoryRuns = 0;
    class Auth {
      token = 'abc';
    }
    const router = setup(fetchMock, () => {
      factoryRuns++;
      const auth = new Auth();
      inject(Router); // proves that an injection context exists
      return () => ({ Authorization: `Bearer ${auth.token}` });
    });
    await router.navigateByUrl('/items/1');
    await TestBed.inject(DRISHTI).flush();
    await router.navigateByUrl('/items/2');
    await TestBed.inject(DRISHTI).flush();
    expect(factoryRuns).toBe(1);
    expect((fetchMock.mock.calls[1]?.[1].headers as Record<string, string>).Authorization).toBe('Bearer abc');
  });
});
