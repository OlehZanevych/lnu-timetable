import { Component, computed, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Observable } from 'rxjs';
import { AccountLinkKind, AuthService } from './auth.service';

/**
 * What happened when the address was submitted, in the form the template renders: a heading, an
 * explanation, and at most one thing to do next.
 */
interface Outcome {
  tone: 'ok' | 'warn' | 'error';
  title: string;
  detail?: string;
  /** The one action offered alongside the message, if any. */
  action?: 'reset' | 'register' | 'login';
}

/**
 * «Реєстрація» and «Відновлення пароля» — one screen, because they are one screen: a field for an
 * e-mail address, a button, and a sentence about what the service found. Which of the two it is
 * arrives as route data (`/register` and `/forgot-password` both point here), and the page can
 * switch from one to the other without a navigation — which is the point of sharing a component
 * rather than writing the same form twice.
 *
 * That switch is the whole reason the registration screen is worth having. Somebody who cannot get
 * in does not know whether they have an account; «зареєструватися» is what they reach for either
 * way. Answering «обліковий запис із такою адресою вже існує» and stopping there would leave them
 * exactly as stuck, so the answer carries the next step with it: one button, already knowing the
 * address, that sends the recovery link instead. The reverse case does the same in the other
 * direction — an address with no account offers registration.
 *
 * Nothing here needs a session, and no route guard protects it. Both operations are reachable by an
 * unauthenticated caller by design: a person with no account and a person who cannot open theirs
 * are precisely the two who cannot sign in first.
 */
@Component({
  selector: 'app-account-request-page',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './account-request-page.html'
})
export class AccountRequestPage {
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  private location = inject(Location);

  /** Which of the two forms this is right now — route data at first, the user's choice after. */
  mode = signal<AccountLinkKind>(this.route.snapshot.data['mode'] === 'reset' ? 'reset' : 'register');

  email = '';
  submitting = signal(false);
  error = signal('');
  outcome = signal<Outcome | null>(null);

  heading = computed(() => (this.mode() === 'register' ? 'Реєстрація' : 'Відновлення пароля'));

  lead = computed(() =>
    this.mode() === 'register'
      ? 'Вкажіть електронну пошту, яку внесено у Ваші дані викладача або студента.'
      : 'Вкажіть електронну пошту Вашого облікового запису — надішлемо посилання для зміни пароля.'
  );

  submit() {
    const email = this.email.trim();
    if (!email) return;
    this.error.set('');
    this.outcome.set(null);
    this.submitting.set(true);
    const mode = this.mode();
    // The two results differ in their status enums and in whether they carry a `role`, and
    // nothing here reads either without first knowing which mode it is in — so the pair is narrowed
    // to what this method actually uses. Without the annotation the conditional produces a union of
    // two Observables, which TypeScript will not let anybody subscribe to.
    const request$: Observable<{ status: string; expiresInMinutes: number | null }> =
      mode === 'register' ? this.auth.requestRegistration(email) : this.auth.requestPasswordReset(email);

    request$.subscribe({
      next: (res) => {
        this.submitting.set(false);
        this.outcome.set(
          mode === 'register'
            ? this.registrationOutcome(res.status, email, res.expiresInMinutes)
            : this.resetOutcome(res.status, email, res.expiresInMinutes)
        );
      },
      error: (e) => {
        this.submitting.set(false);
        this.error.set(e.message);
      }
    });
  }

  /**
   * Takes the action offered by the outcome: the same address, sent down the other road. The e-mail
   * stays in the field, so «Відновити пароль» is one click rather than one click and retyping an
   * address that was correct the first time.
   */
  switchTo(kind: AccountLinkKind) {
    this.mode.set(kind);
    this.outcome.set(null);
    // The address bar has to follow, or the heading says «Відновлення пароля» at `/register` and a
    // reload silently puts the reader back on the other form — with the same button, now sending
    // the other kind of request. `replaceState` rather than a navigation: this is the same screen
    // continuing, not a new one, and Back should still lead where the reader came from.
    this.location.replaceState(kind === 'reset' ? '/forgot-password' : '/register');
    this.submit();
  }

  private registrationOutcome(status: string, email: string, minutes: number | null): Outcome {
    const ttl = minutes ?? 30;
    switch (status) {
      case 'LINK_SENT':
        return {
          tone: 'ok',
          title: `Посилання надіслано на ${email}.`,
          detail: `Перейдіть за ним, щоб завершити реєстрацію. Посилання дійсне ${ttl} хв.`
        };
      case 'ALREADY_REGISTERED':
        return {
          tone: 'warn',
          title: 'Обліковий запис із такою адресою вже існує.',
          detail: 'Якщо Ви забули пароль, надішлемо посилання для його зміни на цю ж адресу.',
          action: 'reset'
        };
      case 'PERSON_ALREADY_LINKED':
        return {
          tone: 'warn',
          title: 'Цю особу вже зареєстровано під іншою адресою.',
          detail: 'Зверніться до адміністратора системи.'
        };
      case 'TOO_MANY_REQUESTS':
        return {
          tone: 'warn',
          title: 'Посилання вже надсилалося щойно.',
          detail: 'Перевірте пошту або спробуйте ще раз за хвилину.'
        };
      case 'MAIL_FAILED':
        return {
          tone: 'error',
          title: 'Не вдалося надіслати листа.',
          detail: 'Спробуйте пізніше або зверніться до адміністратора системи.'
        };
      default:
        return {
          tone: 'warn',
          title: 'Самостійна реєстрація для цієї адреси недоступна.',
          detail:
            'Зареєструватися самостійно можуть лише викладачі та студенти, яких уже внесено в систему, — '
            + 'за посиланням на вказану в їхніх даних електронну пошту. Якщо Ви маєте бути серед них, '
            + 'зверніться до адміністратора системи.'
        };
    }
  }

  private resetOutcome(status: string, email: string, minutes: number | null): Outcome {
    const ttl = minutes ?? 30;
    switch (status) {
      case 'LINK_SENT':
        return {
          tone: 'ok',
          title: `Посилання надіслано на ${email}.`,
          detail: `Перейдіть за ним, щоб встановити новий пароль. Посилання дійсне ${ttl} хв.`
        };
      case 'ACCOUNT_DISABLED':
        return {
          tone: 'warn',
          title: 'Обліковий запис деактивовано.',
          detail: 'Зверніться до адміністратора системи.'
        };
      case 'TOO_MANY_REQUESTS':
        return {
          tone: 'warn',
          title: 'Посилання вже надсилалося щойно.',
          detail: 'Перевірте пошту або спробуйте ще раз за хвилину.'
        };
      case 'MAIL_FAILED':
        return {
          tone: 'error',
          title: 'Не вдалося надіслати листа.',
          detail: 'Спробуйте пізніше або зверніться до адміністратора системи.'
        };
      default:
        return {
          tone: 'warn',
          title: 'Облікового запису з такою адресою немає.',
          detail: 'Якщо Ви викладач або студент, внесений у систему, можете зареєструватися самостійно.',
          action: 'register'
        };
    }
  }
}
