import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AccountLinkCheck, AccountLinkKind, AuthService } from './auth.service';

/**
 * The screen a link in an e-mail opens: `/register/:token` for a викладач or a студент creating
 * their account, `/reset-password/:token` for one replacing a forgotten password. One component,
 * for the same reason `AccountRequestPage` is one — the two differ in a heading and in which
 * mutation is posted, and in nothing a reader of the code would want stated twice.
 *
 * The token is a path segment rather than a query parameter so that `FrontendController` serves it:
 * that controller matches each segment as `[^.]*`, and a base64url token contains no dot, so a
 * reloaded or pasted link reaches the Angular router instead of the static-resource handler.
 *
 * **What it asks for.** A password, and its confirmation. Nothing else — the first and last name
 * shown above the form are the institution's own data, read off the викладач or студент row the
 * link belongs to, and are displayed rather than edited: they were entered by the кафедра that
 * entered the person, and a registration form is not where a surname is corrected.
 *
 * **The link is checked before anything is typed.** A link that has expired, has already been used,
 * or was replaced by a newer one says so on arrival rather than after somebody has chosen a
 * password and pressed the button — and says which of the three, because they lead to different
 * places: ask for a new link, or simply sign in.
 */
@Component({
  selector: 'app-account-link-page',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './account-link-page.html'
})
export class AccountLinkPage {
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly kind: AccountLinkKind = this.route.snapshot.data['mode'] === 'reset' ? 'reset' : 'register';
  private token = this.route.snapshot.paramMap.get('token') ?? '';

  /** null while the link is still being checked. */
  check = signal<AccountLinkCheck | null>(null);
  loadError = signal('');

  password = '';
  confirmPassword = '';
  error = signal('');
  submitting = signal(false);

  heading = computed(() => (this.kind === 'register' ? 'Завершення реєстрації' : 'Новий пароль'));

  /** Whose link this is, in the order a name is written on a document here. */
  personName = computed(() => {
    const c = this.check();
    return c ? [c.lastName, c.firstName].filter(Boolean).join(' ') : '';
  });

  roleLabel = computed(() => {
    const role = this.check()?.role;
    return role === 'LECTURER' ? 'викладач' : role === 'STUDENT' ? 'студент' : '';
  });

  /** What a link that cannot be used says, and where it sends the reader next. */
  problem = computed(() => {
    const c = this.check();
    if (!c || c.isValid) return null;
    switch (c.status) {
      case 'EXPIRED':
        return {
          title: 'Термін дії посилання минув.',
          detail: 'Посилання дійсне 30 хвилин. Замовте нове — воно надійде на ту саму адресу.',
          again: true
        };
      case 'USED':
        return {
          title: 'Посилання вже використано.',
          detail:
            this.kind === 'register'
              ? 'Обліковий запис уже створено — увійдіть за своєю електронною поштою та паролем.'
              : 'Пароль уже змінено за цим посиланням.',
          again: false
        };
      case 'UNAVAILABLE':
        // The link itself is fine; what it points at has changed under it. Nothing on this screen
        // can help, and «замовити нове посилання» would only produce another one that fails the
        // same way — so it is not offered.
        return {
          title:
            this.kind === 'register'
              ? 'Цей обліковий запис уже створено.'
              : 'Обліковий запис недоступний.',
          detail:
            this.kind === 'register'
              ? 'Спробуйте увійти. Якщо це не Ваш обліковий запис, зверніться до адміністратора системи.'
              : 'Його деактивовано. Зверніться до адміністратора системи.',
          again: false
        };
      default:
        return {
          title: 'Посилання недійсне.',
          detail: 'Перевірте, чи скопійовано його повністю, або замовте нове.',
          again: true
        };
    }
  });

  /** Where «замовити нове посилання» leads — the form that issues this kind of link. */
  requestAgainPath = computed(() => (this.kind === 'register' ? '/register' : '/forgot-password'));

  constructor() {
    if (!this.token) {
      this.check.set({ isValid: false, status: 'NOT_FOUND', email: null, firstName: null, lastName: null, role: null });
      return;
    }
    this.auth.accountLink(this.kind, this.token).subscribe({
      next: (c) => this.check.set(c),
      error: (e) => this.loadError.set(e.message)
    });
  }

  submit() {
    this.error.set('');
    if (this.password !== this.confirmPassword) {
      this.error.set('Паролі не збігаються.');
      return;
    }
    if (this.password.length < 8) {
      this.error.set('Пароль повинен містити щонайменше 8 символів.');
      return;
    }
    // BCrypt hashes at most 72 bytes and the service refuses anything longer rather than
    // truncating it. Bytes, not characters — a Ukrainian passphrase is two bytes per letter — so
    // the limit is measured the same way the service measures it, and reported here rather than
    // coming back as a bare WEAK_PASSWORD on a password that is plainly not weak.
    if (new TextEncoder().encode(this.password).length > 72) {
      this.error.set('Пароль задовгий — максимум 72 байти (близько 36 літер кирилицею).');
      return;
    }
    this.submitting.set(true);
    this.auth.redeemAccountLink(this.kind, this.token, this.password).subscribe({
      next: (res) => {
        this.submitting.set(false);
        if (res.isSuccess) {
          // The session is already ours — `redeemAccountLink` adopted the token. Loading the
          // profile before navigating is what lets the shell decide whether «Мій кабінет» belongs
          // in the sidebar, which for a newly registered викладач is the first thing they want.
          this.auth.refreshMe().subscribe(() => this.router.navigateByUrl('/'));
          return;
        }
        this.applyError(res.errorStatus);
      },
      error: (e) => {
        this.submitting.set(false);
        this.error.set(e.message);
      }
    });
  }

  /**
   * A refusal that is about the *link* rather than about what was typed re-renders the page as the
   * dead-link screen — there is nothing useful left to do with the form, and leaving it on screen
   * under a red message invites a second attempt that cannot work either.
   */
  private applyError(status: string | null) {
    switch (status) {
      case 'EXPIRED_TOKEN':
        this.setDead('EXPIRED');
        return;
      case 'USED_TOKEN':
        this.setDead('USED');
        return;
      case 'INVALID_TOKEN':
        this.setDead('NOT_FOUND');
        return;
      case 'WEAK_PASSWORD':
        this.error.set('Пароль повинен містити щонайменше 8 символів.');
        return;
      case 'ALREADY_REGISTERED':
        this.error.set('Обліковий запис із такою адресою вже створено. Спробуйте увійти.');
        return;
      case 'PERSON_ALREADY_LINKED':
        this.error.set('Цю особу вже зареєстровано. Зверніться до адміністратора системи.');
        return;
      case 'ACCOUNT_DISABLED':
        this.error.set('Обліковий запис деактивовано. Зверніться до адміністратора системи.');
        return;
      default:
        this.error.set('Не вдалося завершити дію. Спробуйте ще раз.');
    }
  }

  private setDead(status: AccountLinkCheck['status']) {
    this.check.set({ isValid: false, status, email: null, firstName: null, lastName: null, role: null });
  }
}
