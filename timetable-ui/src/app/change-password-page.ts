import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';

@Component({
  selector: 'app-change-password-page',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './change-password-page.html'
})
export class ChangePasswordPage {
  private auth = inject(AuthService);
  private router = inject(Router);

  currentPassword = '';
  newPassword = '';
  confirmPassword = '';
  error = signal('');
  submitting = signal(false);

  get forced() {
    return this.auth.mustChangePassword();
  }

  submit() {
    this.error.set('');
    if (this.newPassword !== this.confirmPassword) {
      this.error.set('Паролі не збігаються.');
      return;
    }
    this.submitting.set(true);
    this.auth.changePassword(this.currentPassword, this.newPassword).subscribe({
      next: (res) => {
        this.submitting.set(false);
        if (!res.isSuccess) {
          this.error.set(
            res.errorStatus === 'WEAK_PASSWORD'
              ? 'Новий пароль повинен містити щонайменше 8 символів.'
              : 'Поточний пароль вказано невірно.'
          );
          return;
        }
        this.router.navigateByUrl('/');
      },
      error: (e) => {
        this.submitting.set(false);
        this.error.set(e.message);
      }
    });
  }
}
