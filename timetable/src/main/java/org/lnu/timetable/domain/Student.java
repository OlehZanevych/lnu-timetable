package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;

@Data
@GraphQLEntity(table = "students")
public class Student {

    private Long id;

    private String firstName;

    private String lastName;

    @Nullable
    private String email;

    @Nullable
    @Description("Record book (залікова книжка) number")
    private String recordBookNumber;

    @ManyToOne(joinColumn = "academic_group_id")
    private AcademicGroup academicGroup;
}
