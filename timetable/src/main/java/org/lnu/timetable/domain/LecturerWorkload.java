package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;

import java.util.List;

/**
 * A schedulable class requirement: a lecturer delivers a discipline (class type)
 * to an academic group or a combined group. Maps to the article's "class requirement".
 */
@Data
@GraphQLEntity(table = "lecturer_workloads")
public class LecturerWorkload {

    private Long id;

    @Description("Class type: LECTURE, PRACTICAL, LAB or SEMINAR")
    private String classType;

    @Description("Periodicity: WEEKLY or BIWEEKLY")
    private String periodicity;

    @Nullable
    @Description("Number of classes per week to schedule")
    private Integer hoursPerWeek;

    @ManyToOne(joinColumn = "lecturer_id")
    private Lecturer lecturer;

    @ManyToOne(joinColumn = "course_id")
    private Course course;

    @ManyToOne(joinColumn = "academic_group_id")
    private AcademicGroup academicGroup;

    @ManyToOne(joinColumn = "combined_group_id")
    private CombinedGroup combinedGroup;

    @ManyToOne(joinColumn = "working_curriculum_id")
    private WorkingCurriculum workingCurriculum;

    @OneToMany(mappedBy = "workload_id")
    private List<TimetableEntry> timetableEntries;
}
