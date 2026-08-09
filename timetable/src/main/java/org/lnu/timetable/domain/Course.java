package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToMany;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.PermissionParent;
import org.lnu.timetable.framework.annotation.PgEnum;

import java.util.List;

@Data
@GraphQLEntity(table = "courses")
@PermissionParent(value = Department.class, joinColumn = "department_id", nullable = true)
@PermissionParent(value = Faculty.class, joinColumn = "faculty_id", nullable = true)
@PermissionParent(value = Course.class, joinColumn = "parent_course_id", nullable = true)
public class Course {

    private Long id;

    @Description("Discipline name, e.g. Database Systems")
    private String name;

    @PgEnum("course_type")
    @Description("Course type: MANDATORY, ELECTIVE_GROUP, ELECTIVE, OPTIONAL, INTERNSHIP, COURSE_PROJECT, COURSE_WORK, QUALIFICATION_WORK")
    private String courseType;

    @Nullable
    @Description("Faculty directly responsible for this course; set for courses not tied to one specific department")
    @ManyToOne(joinColumn = "faculty_id")
    private Faculty faculty;

    @Nullable
    @ManyToOne(joinColumn = "department_id")
    private Department department;

    @Nullable
    @Description("Parent ELECTIVE_GROUP; set only for ELECTIVE records")
    @ManyToOne(joinColumn = "parent_course_id")
    private Course parentCourse;

    @Nullable
    @Description("Semester this discipline may be planned for; when set, every curriculum item naming it must use this semester. Null means unrestricted")
    private Integer semester;

    @OneToMany(mappedBy = "parent_course_id")
    private List<Course> childCourses;

    @Description("Specialties this course may be added to a curriculum for")
    @ManyToMany(joinTable = "course_specialties", joinColumn = "course_id", inverseJoinColumn = "specialty_id")
    private List<Specialty> specialties;

    @Description("Free-form labels shown after the course's name, e.g. \"англійською\"")
    @OneToMany(mappedBy = "course_id")
    private List<CourseTag> tags;
}
