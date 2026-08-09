-- How long it comfortably takes to get from one building to another.
--
-- A group's day is a sequence of classes, and the gap between two bells is fixed. When the two
-- classes are in different корпуси that gap has to cover the journey between them, and today
-- nothing in the system knows how long that is: the solver places a class in Університетська 1 at
-- 9:50 and the next in Черемшини 31 at 11:30 as readily as it places two in the same corridor.
-- This table is the missing fact. Nothing read it when this migration was written — the schema and
-- the seed came first, the constraint that uses them after; the solver now consults it as Π₄/Π₅.
--
-- **Directed, on purpose.** The row is (from, to), not an unordered pair, and the two directions
-- are allowed to disagree. Lviv is built on hills: Університетська 1 stands at about 295 m and
-- Кирила і Мефодія 8 at about 310 m, and a fifteen-metre climb with a bag is not the same walk
-- back down. 48 of the 171 pairs below differ by a minute or two for that reason. The rest are
-- symmetric, and that is a fact about the terrain rather than a shortcut in the model.
--
-- **No row from a building to itself.** Moving inside one building is not a journey between
-- buildings, and a stored zero would be a value someone could edit into something else. The CHECK
-- keeps the table to what its name says; a reader wanting "same building" gets nothing back and
-- should treat that as no travel at all.
--
-- ── Where the numbers come from ────────────────────────────────────────────────────────────────
-- They are ESTIMATES and are meant to be corrected. Nobody walked these routes with a stopwatch;
-- they were computed from each building's approximate coordinates and elevation:
--
--   * straight-line distance × 1.35, because streets are not straight lines;
--   * 4.8 km/h — a student with a bag, not a tourist;
--   * one minute added per 25 m climbed, twenty-four seconds given back per 25 m descended
--     (Naismith's rule, halved for the descent);
--   * for anything the walk makes long, the lesser of that walk and a tram or bus ride: nine
--     minutes of overhead for reaching a stop, waiting and leaving it, then 15 km/h;
--   * a floor of four minutes, because leaving one building and entering another is never instant
--     even when they share a courtyard — which is why Кирила і Мефодія 6, 8 and 8а, and the two
--     rows the seed holds for Грушевського 4, all sit at four.
--
-- The result runs from 4 to 31 minutes, median 13. Treat every one of them as a first draft: the
-- деканат knows these walks and this table is the place to write down what it knows.

CREATE TABLE IF NOT EXISTS building_travel_times
(
    from_building_id BIGINT  NOT NULL REFERENCES buildings (id) ON DELETE CASCADE,
    to_building_id   BIGINT  NOT NULL REFERENCES buildings (id) ON DELETE CASCADE,
    -- Whole minutes: the bells are on a five-minute grid and nobody plans a walk to the second.
    minutes          INTEGER NOT NULL CHECK (minutes >= 0),
    PRIMARY KEY (from_building_id, to_building_id),
    CONSTRAINT building_travel_times_two_buildings CHECK (from_building_id <> to_building_id)
);

COMMENT ON TABLE building_travel_times IS
    'Comfortable travel time between two buildings, in whole minutes. Directed: (from, to) and (to, from) may differ.';

-- вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 2, 12) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 3, 7) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 4, 9) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 5, 7) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 6, 7) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 7, 7) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 8, 16) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 9, 13) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 10, 6) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 11, 13) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 12, 4) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 13, 6) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 14, 6) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 15, 7) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 16, 7) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 17, 23) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 18, 25) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (1, 19, 19) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 1, 11) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 3, 6) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 4, 9) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 5, 5) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 6, 15) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 7, 5) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 8, 18) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 9, 8) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 10, 13) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 11, 9) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 12, 13) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 13, 7) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 14, 12) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 15, 6) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 16, 11) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 17, 19) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 18, 22) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (2, 19, 21) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 1, 6) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 2, 7) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 4, 10) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 5, 4) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 6, 12) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 7, 4) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 8, 16) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 9, 12) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 10, 10) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 11, 7) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 12, 7) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 13, 4) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 14, 10) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 15, 4) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 16, 5) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 17, 21) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 18, 24) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (3, 19, 20) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 1, 9) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 2, 11) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 3, 11) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 5, 7) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 6, 13) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 7, 7) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 8, 19) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 9, 6) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 10, 6) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 11, 14) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 12, 13) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 13, 11) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 14, 5) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 15, 11) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 16, 13) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 17, 21) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 18, 23) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (4, 19, 17) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 1, 6) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 2, 6) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 3, 5) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 4, 6) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 6, 13) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 7, 4) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 8, 17) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 9, 8) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 10, 8) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 11, 11) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 12, 9) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 13, 5) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 14, 7) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 15, 4) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 16, 9) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 17, 21) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 18, 23) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (5, 19, 19) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 1, 7) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 2, 15) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 3, 13) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 4, 13) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 5, 13) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 7, 13) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 8, 15) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 9, 15) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 10, 8) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 11, 15) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 12, 6) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 13, 12) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 14, 9) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 15, 13) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 16, 11) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 17, 25) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 18, 27) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (6, 19, 18) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 1, 6) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 2, 6) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 3, 5) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 4, 6) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 5, 4) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 6, 13) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 8, 17) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 9, 8) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 10, 8) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 11, 11) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 12, 9) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 13, 5) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 14, 7) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 15, 4) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 16, 9) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 17, 21) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 18, 23) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (7, 19, 19) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 1, 16) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 2, 18) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 3, 16) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 4, 19) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 5, 17) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 6, 15) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 7, 17) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 9, 20) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 10, 17) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 11, 16) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 12, 15) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 13, 16) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 14, 17) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 15, 16) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 16, 15) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 17, 28) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 18, 31) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (8, 19, 24) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 1, 13) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 2, 9) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 3, 13) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 4, 6) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 5, 8) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 6, 15) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 7, 8) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 8, 20) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 10, 11) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 11, 14) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 12, 14) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 13, 13) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 14, 11) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 15, 13) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 16, 14) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 17, 19) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 18, 21) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (9, 19, 18) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 1, 6) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 2, 13) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 3, 11) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 4, 6) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 5, 9) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 6, 9) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 7, 9) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 8, 17) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 9, 11) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 11, 14) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 12, 9) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 13, 11) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 14, 4) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 15, 11) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 16, 13) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 17, 23) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 18, 25) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (10, 19, 17) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 1, 12) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 2, 10) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 3, 7) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 4, 14) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 5, 10) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 6, 15) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 7, 10) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 8, 16) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 9, 14) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 10, 14) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 12, 11) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 13, 7) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 14, 14) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 15, 7) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 16, 6) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 17, 21) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 18, 24) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (11, 19, 22) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 1, 4) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 2, 13) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 3, 7) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 4, 12) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 5, 9) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 6, 6) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 7, 9) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 8, 15) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 9, 14) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 10, 9) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 11, 12) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 13, 7) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 14, 9) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 15, 8) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 16, 5) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 17, 23) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 18, 26) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (12, 19, 20) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 1, 5) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 2, 7) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 3, 4) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 4, 10) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 5, 4) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 6, 12) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 7, 4) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 8, 16) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 9, 12) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 10, 10) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 11, 7) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 12, 6) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 14, 9) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 15, 4) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 16, 4) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 17, 21) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 18, 24) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (13, 19, 20) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 1, 6) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 2, 13) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 3, 11) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 4, 5) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 5, 8) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 6, 9) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 7, 8) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 8, 17) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 9, 11) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 10, 4) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 11, 14) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 12, 9) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 13, 10) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 15, 11) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 16, 13) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 17, 23) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 18, 24) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (14, 19, 17) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 1, 6) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 2, 6) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 3, 4) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 4, 10) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 5, 4) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 6, 13) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 7, 4) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 8, 16) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 9, 11) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 10, 10) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 11, 7) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 12, 7) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 13, 4) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 14, 10) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 16, 5) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 17, 21) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 18, 24) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (15, 19, 20) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 1, 7) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 2, 11) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 3, 5) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 4, 13) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 5, 9) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 6, 11) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 7, 9) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 8, 15) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 9, 14) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 10, 12) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 11, 7) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 12, 5) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 13, 5) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 14, 12) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 15, 5) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 17, 22) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 18, 25) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (16, 19, 21) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 1, 23) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 2, 19) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 3, 21) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 4, 21) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 5, 21) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 6, 25) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 7, 21) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 8, 28) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 9, 19) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 10, 23) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 11, 21) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 12, 23) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 13, 21) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 14, 23) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 15, 21) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 16, 22) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 18, 13) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (17, 19, 28) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Черемшини, 31
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 1, 25) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 2, 22) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 3, 24) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 4, 23) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 5, 23) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 6, 27) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 7, 23) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 8, 31) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 9, 21) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 10, 25) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 11, 24) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 12, 26) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 13, 24) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 14, 24) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 15, 24) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 16, 25) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 17, 13) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (18, 19, 28) ON CONFLICT DO NOTHING;   -- -> вул. Чорновола, 61

-- вул. Чорновола, 61
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 1, 19) ON CONFLICT DO NOTHING;   -- -> вул. Університетська 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 2, 21) ON CONFLICT DO NOTHING;   -- -> вул. Драгоманова, 50
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 3, 20) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 4, 17) ON CONFLICT DO NOTHING;   -- -> проспект Свободи, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 5, 19) ON CONFLICT DO NOTHING;   -- -> вул. Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 6, 18) ON CONFLICT DO NOTHING;   -- -> вул. Дорошенка, 41
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 7, 19) ON CONFLICT DO NOTHING;   -- -> вул. Михайла Грушевського, 4
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 8, 24) ON CONFLICT DO NOTHING;   -- -> вул. Генерала Чупринки, 49
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 9, 18) ON CONFLICT DO NOTHING;   -- -> вул. Валова, 18
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 10, 17) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 19
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 11, 22) ON CONFLICT DO NOTHING;   -- -> вул. Туган-Барановського, 7
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 12, 20) ON CONFLICT DO NOTHING;   -- -> вул. Коперника, 3
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 13, 20) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 6
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 14, 17) ON CONFLICT DO NOTHING;   -- -> вул. Січових Стрільців, 14
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 15, 20) ON CONFLICT DO NOTHING;   -- -> вул. Кирила і Мефодія, 8а
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 16, 21) ON CONFLICT DO NOTHING;   -- -> вул. Саксаганського, 1
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 17, 28) ON CONFLICT DO NOTHING;   -- -> вул. Тарнавського, 107
INSERT INTO public.building_travel_times (from_building_id, to_building_id, minutes) VALUES (19, 18, 28) ON CONFLICT DO NOTHING;   -- -> вул. Черемшини, 31
