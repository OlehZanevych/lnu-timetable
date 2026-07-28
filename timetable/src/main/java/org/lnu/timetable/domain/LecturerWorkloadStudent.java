package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.PermissionParent;

/**
 * One lecturer&harr;student pairing inside a {@link LecturerWorkload}, used when the underlying
 * working curriculum item is taught with {@code teaching_format = 'INDIVIDUALLY'} — a lecturer
 * works one-to-one with each student (e.g. coursework consultations), so the assignment is a set
 * of explicit pairs rather than "these lecturers take these academic groups".
 * <p>
 * Unlike the plain join tables hanging off lecturer_workloads (lecturer_workload_lecturers and
 * friends), this carries two foreign keys that are meaningful only together, so it is a real
 * entity with its own id rather than a many-to-many list. It has no standalone queries or
 * mutations: rows are written exclusively through LecturerWorkload's create/update mutations via
 * the {@code studentAssignments} nested list.
 */
@Data
@GraphQLEntity(table = "lecturer_workload_students")
@PermissionParent(value = LecturerWorkload.class, joinColumn = "lecturer_workload_id")
public class LecturerWorkloadStudent {

    private Long id;

    @ManyToOne(joinColumn = "lecturer_workload_id")
    private LecturerWorkload lecturerWorkload;

    @ManyToOne(joinColumn = "lecturer_id")
    private Lecturer lecturer;

    @ManyToOne(joinColumn = "student_id")
    private Student student;
}
