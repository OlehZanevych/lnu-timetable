import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';

/**
 * A document's variables, collected while the document is being assembled.
 *
 * Most queries in this app are fixed text with a fixed set of variables, and say so inline —
 * `` `query($facultyId: ID, $limit: Int!) { … }` ``. A handful are not: which filters apply, or how
 * many aliased sub-queries there are, is decided in the browser. «Академічні групи» filters by
 * специальність, by факультет, by both or by neither; the student loader asks for one aliased
 * `studentConnection` per group. Those documents are built by concatenation, and the values they
 * filter by would have to be concatenated in with them — which is exactly what this class exists to
 * prevent.
 *
 * `arg` records a value, returns `name: $name` for the document, and keeps the value on the side;
 * `declaration()` returns the operation header naming everything recorded. The value never touches
 * the query text, however the query text is put together.
 *
 * ```ts
 * const v = new GqlVars();
 * const args = [v.arg('limit', 'Int!', 500),
 *               v.optionalArg('facultyId', 'ID', this.facultyId)].filter(Boolean);
 * const q = `${v.declaration()}{ academicGroups { academicGroupConnection(${args.join(', ')}) { … } } }`;
 * this.gql.request(q, v.values);
 * ```
 */
export class GqlVars {
  private readonly declarations: string[] = [];

  /** What to send alongside the document — pass straight to `GraphqlService.request`. */
  readonly values: Record<string, unknown> = {};

  /**
   * Declare `$name` of `type`, bound to `value`, and return the reference `$name`.
   *
   * A name already taken is reused when it carries the same value and given a numbered sibling when
   * it does not — two declarations of one name is a document GraphQL rejects outright, and the
   * callers that assemble a document from parts cannot always know what the other parts declared
   * (`BaseEntity` names its filters after metadata, so one host page's two filters can collide).
   */
  ref(name: string, type: string, value: unknown): string {
    let n = name;
    for (let i = 2; n in this.values && JSON.stringify(this.values[n]) !== JSON.stringify(value); i++) {
      n = name + i;
    }
    if (!(n in this.values)) {
      this.declarations.push(`$${n}: ${type}`);
      this.values[n] = value;
    }
    return `$${n}`;
  }

  /** `name: $name`, ready to drop into an argument list. */
  arg(name: string, type: string, value: unknown): string {
    return `${name}: ${this.ref(name, type, value)}`;
  }

  /**
   * The same, or `''` when there is nothing to filter by — so an unused filter is *absent* from the
   * document rather than present and null, which is the shape the server has always been sent.
   */
  optionalArg(name: string, type: string, value: unknown): string {
    const empty = value === null || value === undefined || value === ''
      || (Array.isArray(value) && value.length === 0);
    return empty ? '' : this.arg(name, type, value);
  }

  /** `query($a: ID!, $b: Int!) `, or `''` when nothing was recorded. */
  declaration(operation: 'query' | 'mutation' = 'query'): string {
    return this.declarations.length ? `${operation}(${this.declarations.join(', ')}) ` : '';
  }
}

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
