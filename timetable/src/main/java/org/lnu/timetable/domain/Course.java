package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;

import java.util.List;

@Data
@GraphQLEntity(table = "courses")
public class Course {

    private Long id;

    @Description("Discipline name, e.g. Database Systems")
    private String name;

    @Description("Course type: MANDATORY, ELECTIVE_GROUP, ELECTIVE, OPTIONAL, INTERNSHIP, COURSE_PROJECT, COURSE_WORK, QUALIFICATION_WORK")
    private String courseType;

    @ManyToOne(joinColumn = "department_id")
    private Department department;

    @Nullable
    @Description("Parent ELECTIVE_GROUP; set only for ELECTIVE records")
    @ManyToOne(joinColumn = "parent_course_id")
    private Course parentCourse;

    @OneToMany(mappedBy = "parent_course_id")
    private List<Course> childCourses;
}
