package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.PermissionParent;

@Data
@GraphQLEntity(table = "course_tags")
@PermissionParent(value = Course.class, joinColumn = "course_id")
public class CourseTag {

    private Long id;

    @Description("Free-form label shown after the course's name, e.g. \"англійською\"")
    private String tag;

    @ManyToOne(joinColumn = "course_id")
    private Course course;
}
