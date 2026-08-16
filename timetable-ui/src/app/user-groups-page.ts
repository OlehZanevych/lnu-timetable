import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';

interface ManageableGroup {
  id: string;
  name: string;
  description: string | null;
  members: { id: string }[];
}

/**
 * «Групи користувачів» — the groups this account may administer, and the way into each of them.
 *
 * The list comes from `manageableGroups` rather than from `groups`, which returns every group to
 * every signed-in caller so that access can be granted to one. The narrower question — which of them
 * may I open — is the service's to answer (`GroupAdminPolicy`), and asking it is what lets a деканат
 * holding MANAGE on their факультет reach the group that факультет was delegated to without an
 * administrator, while an account with no delegation rights sees an empty list and is told why.
 *
 * The sidebar link is drawn for anyone holding MANAGE anywhere, which is a guess this page then
 * corrects: the client cannot know which groups those grants cover without asking, and a link that
 * leads to «жодної групи» is a better failure than a screen nobody can find.
 */
@Component({
  selector: 'app-user-groups-page',
  templateUrl: './user-groups-page.html',
  imports: [RouterLink]
})
export class UserGroupsPage {
  private gql = inject(GraphqlService);
  auth = inject(AuthService);

  groups = signal<ManageableGroup[] | null>(null);
  error = signal('');

  constructor() {
    const query = `{ manageableGroups { id name description members { id } } }`;
    this.gql.request<{ manageableGroups: ManageableGroup[] }>(query).subscribe({
      next: (d) => this.groups.set(d.manageableGroups),
      error: (e) => this.error.set(e.message)
    });
  }
}
