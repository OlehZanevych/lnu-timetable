-- Curriculum positions attached to an elective instead of to its group.
--
-- An ELECTIVE_GROUP is the slot a навчальний план reserves; which of its children fills that slot
-- is decided one level down, on working_curriculum_items.course_id (see CurriculumSchemaConfig and
-- the client's course page). A curriculum_items row whose own course is an ELECTIVE therefore
-- describes a position the model has no place for. Two things went wrong because of it: the
-- elective appeared as a top-level component of the plan beside the група it belongs to, and where
-- the група carried the same hours they were counted twice — toward the programme's volume and
-- toward the 25 % частка вибіркових of ст. 62 ч. 1 п. 15 alike.
--
-- data.sql carries 28 such rows across 6 specialties, and none of them is an empty leftover: every
-- one is delivered by somebody. So this DELETE cascades, and that is deliberate rather than
-- overlooked — ON DELETE CASCADE runs curriculum_items → curriculum_item_hours →
-- working_curriculum_items → lecturer_workloads → timetable_entries. Against data.sql that is
-- 41, 43, 43 and 47 rows respectively; no combined_working_curriculum_item loses a member.
--
-- The teaching those 47 entries described is real and has to be re-entered under the група's own
-- position. Nothing here can do that automatically: 19 of the 28 have no група position in their
-- specialty at all, one has a position lacking the hour types the child carries, and only 8 could
-- have been moved. Half a migration that fixed 8 and left 20 would be worse than one that states
-- plainly what it removed, which is what the NOTICE below is for — Flyway prints it to the
-- application log as the migration runs.
--
-- Re-runnable in effect: after the first run nothing matches, so a rebuilt database (reset_db.sh
-- re-applies data.sql, 28 rows and all) is cleaned again the next time the service starts.

DO
$$
    DECLARE
        items   INTEGER;
        hours   INTEGER;
        working INTEGER;
        loads   INTEGER;
        entries INTEGER;
    BEGIN
        SELECT count(*) INTO items
        FROM curriculum_items ci
                 JOIN courses c ON c.id = ci.course_id
        WHERE c.course_type = 'ELECTIVE';

        SELECT count(DISTINCT cih.id), count(DISTINCT wci.id), count(DISTINCT lw.id), count(DISTINCT te.id)
        INTO hours, working, loads, entries
        FROM curriculum_items ci
                 JOIN courses c ON c.id = ci.course_id
                 LEFT JOIN curriculum_item_hours cih ON cih.curriculum_item_id = ci.id
                 LEFT JOIN working_curriculum_items wci ON wci.curriculum_item_hours_id = cih.id
                 LEFT JOIN lecturer_workloads lw ON lw.working_curriculum_item_id = wci.id
                 LEFT JOIN timetable_entries te ON te.workload_id = lw.id
        WHERE c.course_type = 'ELECTIVE';

        IF items > 0 THEN
            RAISE NOTICE
                'Removing % curriculum item(s) attached to an ELECTIVE course. Cascading with them: % hour row(s), % working curriculum item(s), % lecturer workload(s), % timetable entr(ies). That teaching must be re-entered under the elective group''s own plan position.',
                items, hours, working, loads, entries;
        END IF;
    END
$$;

DELETE
FROM curriculum_items
WHERE course_id IN (SELECT id FROM courses WHERE course_type = 'ELECTIVE');
