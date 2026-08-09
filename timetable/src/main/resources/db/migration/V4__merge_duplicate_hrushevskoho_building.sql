-- Two rows for one корпус.
--
--   id 5  «Корпус на вул. Грушевського, 4»          вул. Грушевського, 4          Львів  79005
--   id 7  «Корпус на вул. Михайла Грушевського, 4»  вул. Михайла Грушевського, 4  Львів  79005
--
-- The street's official name is вулиця Михайла Грушевського; «вул. Грушевського» is what everyone
-- writes. Same street, same number, same city, same postal code — one building entered twice, under
-- both of its names, by two different people.
--
-- It is worth removing rather than tolerating because of what the duplicate does to the two
-- features built on top of `buildings`. `building_travel_times` gains a whole extra row and column
-- for a place that already has one — 36 journeys to and from a building nobody can be in — and the
-- pair reads as four minutes apart, which is the floor, which is exactly what "the same place"
-- looks like in that table. And the timetable generator, which now asks how long it takes to get
-- from one корпус to another, would answer four minutes for a journey of zero.
--
-- What each side actually holds, in data.sql:
--
--   id 5:  5 rooms,  1 faculty (Біологічний),  36 travel rows
--   id 7:  0 rooms,  1 faculty (Геологічний),  36 travel rows,  0 timetable entries
--
-- So the merge is one UPDATE and one DELETE: the Геологічний факультет moves to the row that has
-- the rooms, and the empty duplicate goes. `buildings` is referenced from exactly three columns —
-- `rooms.building_id`, `faculties.building_id` and the two ends of `building_travel_times` — and
-- the first is already empty for id 7, so nothing else can be pointing at it.
--
-- To undo: re-insert the building and set faculties.building_id back to it for the Геологічний
-- факультет. The travel rows would have to be re-seeded, and they are estimates anyway (see V2).
--
-- Guarded on the duplicate still being empty. If somebody has since put a room in it, the two rows
-- are no longer the same story and this migration must not guess — it does nothing and says so.

DO
$$
    DECLARE
        rooms_in_duplicate INTEGER;
        moved_faculties    INTEGER;
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM buildings WHERE id = 7 AND address = 'вул. Михайла Грушевського, 4')
            OR NOT EXISTS (SELECT 1 FROM buildings WHERE id = 5 AND address = 'вул. Грушевського, 4') THEN
            RAISE NOTICE 'Buildings 5/7 are not the pair this migration was written for; leaving them alone.';
            RETURN;
        END IF;

        SELECT count(*) INTO rooms_in_duplicate FROM rooms WHERE building_id = 7;
        IF rooms_in_duplicate > 0 THEN
            RAISE NOTICE 'Building 7 now holds % room(s); it is no longer an empty duplicate, so nothing was merged.',
                rooms_in_duplicate;
            RETURN;
        END IF;

        UPDATE faculties SET building_id = 5 WHERE building_id = 7;
        GET DIAGNOSTICS moved_faculties = ROW_COUNT;

        DELETE FROM buildings WHERE id = 7;

        RAISE NOTICE 'Merged building 7 (вул. Михайла Грушевського, 4) into 5 (вул. Грушевського, 4): % faculty/faculties moved, 36 travel row(s) cascaded away.',
            moved_faculties;
    END
$$;
