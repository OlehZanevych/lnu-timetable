package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.PermissionParent;

import java.util.List;

/**
 * A named grid of the times a class may begin at — a "розклад дзвінків".
 *
 * Not every kind of class runs on the same bells: physical education usually starts on its own
 * grid so students have time to reach a sports hall and back, and an evening or part-time
 * programme may shift the whole day later. A {@link LecturerWorkload} therefore picks the set its
 * classes are scheduled on, and its timetable entries choose a time out of that set.
 *
 * Exactly one set is the default (the one offered wherever nothing more specific applies), and a
 * set may instead be scoped to a single faculty — in which case it can never be the default,
 * because a default is by definition university-wide. Both rules are enforced in the database
 * (class_start_time_sets_single_default and class_start_time_sets_default_scope_check).
 */
@Data
@GraphQLEntity(table = "class_start_time_sets")
@PermissionParent(value = Faculty.class, joinColumn = "faculty_id", nullable = true)
public class ClassStartTimeSet {

    private Long id;

    @Description("Set name, e.g. \"Основний розклад дзвінків\"")
    private String name;

    @Description("The university-wide default set; at most one row has this, and it is never faculty-scoped")
    private Boolean isDefault;

    /**
     * NULL means the set is available to every faculty; when set, only that faculty may use it.
     */
    @Nullable
    @ManyToOne(joinColumn = "faculty_id")
    private Faculty faculty;

    @OneToMany(mappedBy = "class_start_time_set_id")
    private List<ClassStartTime> classStartTimes;
}
