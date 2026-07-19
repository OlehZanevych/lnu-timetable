import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from './auth.service';

@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [FormsModule],
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
