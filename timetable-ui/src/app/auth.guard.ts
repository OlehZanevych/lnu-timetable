import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { AuthService } from './auth.service';

/** Redirects to /login when there's no signed-in user, and to /change-password when a temporary
 *  password hasn't been replaced yet (except for the change-password route itself). A stored
 *  token whose user profile hasn't been fetched yet (e.g. right after a page reload) is resolved
 *  via `refreshMe()` before deciding — an invalid/expired token then falls through to /login. */
export const authGuard: CanActivateFn = (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated()) {
    return router.createUrlTree(['/login'], { queryParams: { redirectTo: state.url } });
  }

  const decide = () =>
    auth.mustChangePassword() && state.url !== '/change-password'
      ? router.createUrlTree(['/change-password'])
      : true;

  if (auth.currentUser()) {
    return decide();
  }
  return auth.refreshMe().pipe(
    map(() => decide()),
    catchError(() => of(router.createUrlTree(['/login'], { queryParams: { redirectTo: state.url } })))
  );
};

/** Guards /admin: requires an authenticated administrator. */
export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isAdmin() ? true : router.createUrlTree(['/']);
};
