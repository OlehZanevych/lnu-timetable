-- Adds «Волонтери — наповнення даних», the group the people entering this university's data belong
-- to, and the grants that decide what entering it may touch.
--
-- The system is empty until somebody types the university into it: кафедри, освітні програми,
-- дисципліни, навчальні плани, робочі навчальні плани, викладачі, аудиторії, навантаження, розклад.
-- That work is done by volunteers, for a few weeks, and it is the one job in this product that is
-- both large and temporary. The group exists so that it can be handed out once — an invitation link
-- rather than an administrator creating and scoping twenty accounts — and taken away in one act when
-- the data is in: delete the group, and every grant below travels with it (`permissions.group_id`
-- is ON DELETE CASCADE), leaving the accounts themselves intact.
--
-- ---------------------------------------------------------------- what it may do, and how that is said
--
-- One `FACULTY` grant at `EDIT` per факультет — nineteen rows rather than one `GLOBAL` row, and the
-- difference is exactly the three exclusions the job came with.
--
--   global properties     `updateGlobalProperty` requires `GLOBAL` at `EDIT` or above, and no
--                         faculty-scoped grant is `GLOBAL` however many of them are held. The
--                         semester dates, the length of an academic hour and the solver's weights
--                         stay where they belong.
--   creating accounts     `createUser`, `setUserLink` and `setUserActive` are administrator-only,
--                         which in this model is `GLOBAL` at `MANAGE`. Group membership is not
--                         administrator-only any more — it needs `MANAGE` over everything the group
--                         can reach (`GroupAdminPolicy`) — but that is two levels above `EDIT`
--                         either way, so a volunteer can neither create an account, nor add anybody
--                         to this group, nor hand their own access to anybody else.
--   deleting anything     deletion needs `FULL`. `EDIT` creates and corrects; it cannot remove a
--                         кафедра, a група or an освітня програма — and deletion cascades in this
--                         schema, which is why that is a level of its own and not part of «may
--                         modify». A volunteer who has entered something wrongly can fix every
--                         field of it; removing the row is an administrator's act, deliberately.
--
-- Two things follow from the same choice and are worth knowing before somebody reports them as bugs.
--
--   **Корпуси and наукові ступені stay out of reach.** `Building` and `AcademicDegree` are
--   `@PermissionRoot` — nothing is above them, so only a `GLOBAL` grant reaches them at all. A
--   volunteer entering an аудиторія must therefore attach it to a факультет (which they hold), and
--   the building it stands in has to exist already. Both lists are short, both are already filled in
--   by `data.sql`, and adding to either is an administrator's act.
--
--   **An аудиторія that belongs to no факультет stays out of reach, and there are 31 of them.**
--   `Room` declares two parents, `Faculty?` and `Building?`, and coverage needs one of them to be
--   set: in `data.sql` as shipped, 31 of 75 rooms name a корпус and no факультет, and 12 of 14
--   room groups name neither a факультет nor a кафедра. Those rows are university-wide objects and
--   only a `GLOBAL` grant reaches them. Two ways to close it, both an administrator's choice rather
--   than this migration's: give those rooms a факультет (which is what they are, in fact, and is
--   worth doing anyway), or add one `BUILDING` grant at `EDIT` per корпус — `Room` hangs off a
--   корпус as well, so that covers every аудиторія in it whichever факультет owns it. The second
--   also brings корпуси themselves and `BuildingTravelTime` into the group's scope, which is data
--   entry too, and still reaches neither the global properties nor the accounts. Room groups
--   belonging to nobody are reachable by neither, and stay an administrator's.
--
--   **A faculty-scoped розклад дзвінків is reachable.** `ClassStartTimeSet` hangs off a факультет
--   when it names one, so «Вечірні заняття (ФПМІ)» — the one such row in `data.sql` — can be
--   corrected by this group, while the two university-wide sets («Основний розклад дзвінків»,
--   «Фізичне виховання») cannot, having no факультет above them. If the bells must be untouchable
--   outright, the way to say so is to leave every set university-wide (`faculty_id IS NULL`) rather
--   than to weaken these grants: a set that exists *for* one faculty is, by construction, part of
--   what a grant on that faculty covers.
--
-- And one thing this migration cannot do for the future: a факультет created after it runs gets no
-- grant, because the rows are enumerated from `faculties` as it stands today. Adding a faculty
-- while the volunteers are working means adding one grant on «Користувачі та права», which is the
-- honest cost of scoping by faculty instead of university-wide.
--
-- Idempotent, as every migration here has to be, and it has already had to be: `data.sql` was
-- re-dumped after this ran, so the shipped dump now carries the group, the nineteen grants, and the
-- `flyway_schema_history` row saying this migration is applied. On a database built from those two
-- files it therefore does not run at all — and would insert nothing if it did. It exists for the
-- databases the dump does not reach: a deployment holding real data, and anything seeded from an
-- older dump. Both statements are guarded on the row not being there.

-- ---------------------------------------------------------------- 1. the group

INSERT INTO groups (name, description)
SELECT 'Волонтери — наповнення даних',
       'Temporary: volunteers entering the university''s data — departments, degree programmes, ' ||
       'courses, curricula, lecturers, rooms, workloads and the timetable. One FACULTY grant at ' ||
       'EDIT per faculty, so global properties, university-wide bell schedules and account ' ||
       'management stay out of reach. Delete the group when the data is in; its grants go with it.'
WHERE NOT EXISTS (SELECT 1 FROM groups WHERE name = 'Волонтери — наповнення даних');

-- ---------------------------------------------------------------- 2. one EDIT grant per faculty
--
-- `granted_by` is left NULL: nobody granted these, a migration did, and pointing them at the seeded
-- administrator would say something untrue about who is answerable for them. It costs nothing —
-- revoking a grant needs MANAGE from a strict ancestor of its resource, which any `GLOBAL` holder
-- has over every факультет, and `granted_by` is only the second, self-service road to the same act.

INSERT INTO permissions (grantee_type, group_id, resource_type, resource_id, level)
SELECT 'GROUP', g.id, 'FACULTY', f.id, 'EDIT'
FROM groups g
         CROSS JOIN faculties f
WHERE g.name = 'Волонтери — наповнення даних'
  AND NOT EXISTS (SELECT 1
                  FROM permissions p
                  WHERE p.grantee_type = 'GROUP'
                    AND p.group_id = g.id
                    AND p.resource_type = 'FACULTY'
                    AND p.resource_id = f.id);
