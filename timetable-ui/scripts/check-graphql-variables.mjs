#!/usr/bin/env node
/**
 * Fails when a GraphQL document in `src/app` could carry a value.
 *
 * Every argument this client sends travels as a variable — no id, no filter, no page size, no
 * `global_properties` name is ever written into a query document (see the README's *Every value
 * travels as a variable*). That rule is easy to state and easy to forget the next time a query is
 * added, which is what this script is for.
 *
 *     npm run lint:graphql
 *
 * It reads the TypeScript AST rather than the file text, so a backtick inside a comment or a
 * string cannot be mistaken for the start of a query, and it only inspects string and template
 * literals that look like GraphQL. (Plain string literals count: a document with nothing to
 * interpolate is written as one, and it can still name an argument the schema does not have.) Four things fail it:
 *
 *   1. a value interpolated into the document          `facultyId: "${this.facultyId}"`
 *   2. the same for a list                             `departmentIds: ["${id}"]`
 *   3. a literal written into the document             `limit: 1000`
 *   4. an interpolation that is not a GqlVars reference — the escape hatch for documents assembled
 *      at runtime is `v.arg(…)` / `v.ref(…)`, and anything else in that position is a value
 *   5. an argument name the service does not declare, written into a document  `timeLimit: $timeLimit`
 *   6. the same, produced by a GqlVars call                                   `v.arg('timeLimit', …)`
 *   7. a variable used but never declared              `query($limit: Int!) { … limit: $other }`
 *
 * The fifth is the one that got away once and is the reason this list is not four items long.
 * `GqlVars.ref` renames a variable whose name is taken but whose value differs — a second `limit`
 * on the same document becomes `$limit2` — and a caller that reaches for `v.arg('timeLimit', …)` to
 * get that separation instead renames the *argument*, emitting `timeLimit: $timeLimit`. Every one
 * of the checks above passes: it is a variable, it is declared, nothing is interpolated. Only the
 * server disagrees, at runtime, with `Unknown field argument 'timeLimit'`. So the argument names are
 * now checked against `ARG_TYPES`, which is the list of what the service actually declares.
 *
 * Both spellings have to be checked, and the second is the one that bit: `v.arg(name, …)` emits
 * `name: $name`, so the offending text never appears in the source for the fifth check to find. The
 * *variable* may be renamed freely — that is what `v.ref('limit', …)` is for, and how a document
 * carrying two different page sizes ends up with `$limit` and `$limit2` — but the argument it is
 * bound to has to be one the schema knows.
 *
 * Plus one ordering trap that type-checks perfectly and fails at the server: a template literal
 * evaluates left to right, so `${v.declaration()}` read *before* the `v.arg(…)` calls it is meant
 * to describe emits an operation header missing half its variables.
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');

/**
 * Every argument name the client sends, with the GraphQL type the service declares for it — read
 * off `QueryDefinition` in the four `*SchemaConfig` classes:
 * `filter(…)`/`relationFilter(…)` → `ID`, `relationFilterList(…)` → `[ID!]`,
 * `relationFilterString(…)` → `String`, a connection's paging → `Int!`, an entity lookup's `id`
 * and a `globalProperty`'s `name` → `ID!`.
 */
const ARG_TYPES = {
  id: 'ID!', name: 'ID!', limit: 'Int!', offset: 'Int!',
  abstractRoomId: 'ID', academicGroupId: 'ID', buildingId: 'ID', classStartTimeSetId: 'ID',
  courseId: 'ID', curriculumItemId: 'ID', degreeProgramId: 'ID', departmentId: 'ID',
  facultyId: 'ID', fromBuildingId: 'ID', parentCourseId: 'ID', roomId: 'ID',
  toBuildingId: 'ID', workloadId: 'ID',
  abstractRoomIds: '[ID!]', academicGroupIds: '[ID!]', departmentIds: '[ID!]',
  lecturerIds: '[ID!]', roomIds: '[ID!]',
  semesterParity: 'String',
  value: 'String!',
  // Authentication, accounts and access — the hand-rolled half of the schema
  // (DynamicGraphQLSchemaBuilder#addAuthQueryFields / #addAuthMutationFields).
  email: 'String!', password: 'String!', currentPassword: 'String!', newPassword: 'String!',
  firstName: 'String!', lastName: 'String!', temporaryPassword: 'String!',
  userId: 'ID', groupId: 'ID', lecturerId: 'ID', studentId: 'ID',
  active: 'Boolean!', description: 'String', query: 'String!',
  granteeType: 'String!', permissionId: 'ID!', level: 'AccessLevel!',
  resourceType: 'String!', resourceId: 'ID', resourceIds: '[ID!]!', includeInherited: 'Boolean',
  // Self-service registration and password recovery (SelfServiceSchema) — the one-time link's
  // token, which is a value like any other and travels as a variable like any other.
  token: 'String!',
};

const NAME = `(${Object.keys(ARG_TYPES).join('|')})`;
const GRAPHQLISH = /\b(query|mutation)\s*[({]|Connection\(|\{\s*nodes\b|\(id:/;
const CHECKS = [
  [/[\w}]\s*:\s*"\$\{/, 'a value interpolated straight into the document'],
  [/[\w}]\s*:\s*\["\$\{/, 'a list value interpolated straight into the document'],
  [new RegExp(`${NAME}\\s*:\\s*(\\d+|"[^"\\n]*")(?=\\s*[,)])`), 'a literal value written into the document'],
  [new RegExp(`${NAME}\\s*:\\s*\\$\\{(?!\\s*[^}]*\\.(ref|arg|optionalArg)\\()`), 'an interpolation that is not a GqlVars reference'],
];

/**
 * `argName: $variable` written literally in a document. The leading `[({,\s]` is what keeps a
 * variable *declaration* — `$input: ${m.name}InputPayload!`, where the name is preceded by `$` —
 * from being read as an argument.
 */
const ARG_USE = /(?:^|[({,\s])([a-z][A-Za-z0-9_]*)\s*:\s*\$(\w+)/g;

/** `v.arg('name', …)` / `v.optionalArg('name', …)` — the runtime spelling of the same thing. */
const ARG_CALL = /\.(?:arg|optionalArg)\(\s*'([^']+)'/g;

/**
 * A fully literal operation header — `query($a: ID!, $b: Int!)`. Only these can be checked for
 * undeclared variables: a header assembled at runtime (`${v.declaration()}`) is by construction the
 * list of whatever was asked for, and its text is not in the source to read.
 */
const LITERAL_HEADER = /\b(?:query|mutation)\s*\(([^)]*)\)\s*\{/;
const DECLARED = /\$(\w+)\s*:/g;
/** `$name` used as a value, i.e. not immediately followed by a `:` that would make it a declaration. */
const USED = /\$(\w+)(?!\s*:)/g;

/**
 * An entity's create/update payload argument is named after the entity (`faculty:`,
 * `buildingTravelTime:`, `timetableEntry:`), so there is no fixed list of those to check against.
 * What identifies them instead is the variable they are bound to: its declared type ends in
 * `InputPayload`. That holds whether the document names it `$input` or, in the batched apply on
 * the timetable page, `$i0`…`$i49` — the numeric suffix of which is itself an interpolation, hence
 * the optional `${…}` between the name and the colon.
 *
 * Collected per *file* rather than per document, because a document assembled from parts keeps its
 * variable declarations in a different template literal from the field that uses them (the batched
 * apply builds `args` and `fields` separately and interpolates both into a third).
 */
const PAYLOAD_DECL = /\$(\w+)(?:\$\{[^}]*\})?\s*:\s*[^,)]*InputPayload/g;

let problems = 0;
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.ts')).sort()) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const flag = (pos, message) => {
    problems++;
    console.error(`${file}:${sf.getLineAndCharacterOfPosition(pos).line + 1}  ${message}`);
  };

  const payloadVars = new Set([...src.matchAll(PAYLOAD_DECL)].map((m) => m[1]));

  // Checked over the whole file rather than per document: these calls sit in the template's
  // *expressions*, which `walk` deliberately does not descend into.
  for (const m of src.matchAll(ARG_CALL)) {
    if (m[1] in ARG_TYPES) continue;
    flag(m.index, `an argument name the service does not declare: v.arg('${m[1]}', …) emits `
      + `${m[1]}: $${m[1]} — to rename only the variable, use v.ref('<real argument name>', …)`);
  }

  const walk = (node) => {
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isStringLiteral(node)) {
      const text = src.slice(node.getStart(), node.end);
      if (GRAPHQLISH.test(text)) {
        for (const [re, what] of CHECKS) {
          const m = re.exec(text);
          if (m) { flag(node.getStart() + m.index, `${what}: ${m[0].replace(/\s+/g, ' ').slice(0, 50)}`); break; }
        }
        for (const m of text.matchAll(ARG_USE)) {
          const [, argName, variable] = m;
          if (argName in ARG_TYPES || payloadVars.has(variable)) continue;
          flag(node.getStart() + m.index,
            `an argument name the service does not declare: ${argName} (sent as $${variable})`);
        }

        // Every variable the body reads must appear in the header. GraphQL rejects the whole
        // document otherwise ("Variable '$x' is not defined by operation"), and nothing else here
        // notices: the argument name is right, the value is a variable, and the value it is bound
        // to is passed in the variables map — it is only the header that never heard about it.
        const header = LITERAL_HEADER.exec(text);
        if (header && !text.includes('${')) {
          const declared = new Set([...header[1].matchAll(DECLARED)].map((d) => d[1]));
          const seen = new Set();
          for (const u of text.slice(header.index + header[0].length).matchAll(USED)) {
            if (declared.has(u[1]) || seen.has(u[1])) continue;
            seen.add(u[1]);
            flag(node.getStart() + header.index,
              `$${u[1]} is used but not declared by the operation — the server rejects the document`);
          }
        }

        const decl = text.indexOf('.declaration(');
        const firstArg = Math.min(...['.arg(', '.ref(', '.optionalArg(']
          .map((s) => { const i = text.indexOf(s); return i < 0 ? Infinity : i; }));
        if (decl >= 0 && firstArg < Infinity && decl < firstArg) {
          flag(node.getStart() + decl, 'declaration() is read before the arg()/ref() calls it must describe');
        }
      }
      return;   // the template's own expressions are not documents
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
}

if (problems) {
  console.error(`\n${problems} problem(s). Every argument must name a variable — see the README's `
    + `"Every value travels as a variable".`);
  process.exit(1);
}
console.log('GraphQL documents: every argument is a variable, and every document declares them in time.');
