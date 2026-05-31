import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';

/** Minimal GraphQL-over-HTTP client. */
@Injectable({ providedIn: 'root' })
export class GraphqlService {
  private http = inject(HttpClient);

  request<T = any>(query: string, variables: Record<string, any> = {}): Observable<T> {
    return this.http
      .post<{ data: T; errors?: { message: string }[] }>('/graphql', { query, variables })
      .pipe(
        map((res) => {
          if (res.errors?.length) {
            throw new Error(res.errors.map((e) => e.message).join('; '));
          }
          return res.data;
        })
      );
  }
}
