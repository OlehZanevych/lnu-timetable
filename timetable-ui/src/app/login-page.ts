import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService, SESSION_END_MESSAGES } from './auth.service';

@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './login-page.html'
})
export class LoginPage {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  email = '';
  password = '';
  error = signal('');
  submitting = signal(false);

  /**
   * Why the user is looking at this form when they did not ask to be — an expired session, a token
   * the service refused, an account deactivated mid-session. Empty when they arrived here by
   * signing out or by opening the app cold, which needs no explanation.
   */
  sessionNotice = computed(() => {
    const reason = this.auth.sessionEndReason();
    return reason ? SESSION_END_MESSAGES[reason] : '';
  });

  submit() {
    this.error.set('');
    this.submitting.set(true);
    this.auth.login(this.email, this.password).subscribe({
      next: (res) => {
        this.submitting.set(false);
        if (!res.isSuccess) {
          this.error.set(
            res.errorStatus === 'ACCOUNT_DISABLED'
              ? 'Обліковий запис деактивовано.'
              : 'Невірна ел. пошта або пароль.'
          );
          return;
        }
        this.auth.refreshMe().subscribe(() => {
          const redirectTo = this.route.snapshot.queryParamMap.get('redirectTo');
          if (res.mustChangePassword) {
            this.router.navigateByUrl('/change-password');
          } else {
            this.router.navigateByUrl(redirectTo || '/');
          }
        });
      },
      error: (e) => {
        this.submitting.set(false);
        this.error.set(e.message);
      }
    });
  }
}
