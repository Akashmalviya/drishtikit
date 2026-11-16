import { DestroyRef, InjectionToken, inject, makeEnvironmentProviders, provideEnvironmentInitializer, type EnvironmentProviders } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { createDrishti, type DrishtiBrowserConfig, type DrishtiClient } from '@drishtikit/browser';
import { screenPattern } from './screen';

/** The settings of `provideDrishti`. They are the settings of the browser client, with one change in `headers`. */
export interface DrishtiAngularConfig extends Omit<DrishtiBrowserConfig, 'headers'> {
  /**
   * A factory. It runs once in an injection context (so you can use `inject()`)
   * and returns the function that gives the headers for each request.
   * Example: `headers: () => { const auth = inject(AuthService); return () => ({ Authorization: `Bearer ${auth.token()}` }); }`
   */
  headers?: () => () => Record<string, string>;
}

/** The browser client. Inject it to call `track()`. */
export const DRISHTI = new InjectionToken<DrishtiClient>('DRISHTI');

/**
 * One line in `app.config.ts`. It makes the browser client and records a `screen` event
 * at each navigation. The screen is the route pattern (for example `items/:id`), never the URL.
 */
export function provideDrishti(config: DrishtiAngularConfig): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: DRISHTI,
      useFactory: (): DrishtiClient => {
        const { headers: headersFactory, ...rest } = config;
        const headers = headersFactory ? headersFactory() : undefined;
        return createDrishti({ ...rest, ...(headers ? { headers } : {}) });
      },
    },
    provideEnvironmentInitializer(() => {
      const client = inject(DRISHTI);
      const router = inject(Router);
      const subscription = router.events.subscribe((event) => {
        if (event instanceof NavigationEnd) client.screen(screenPattern(router.routerState.snapshot.root));
      });
      inject(DestroyRef).onDestroy(() => {
        subscription.unsubscribe();
        client.destroy();
      });
    }),
  ]);
}
