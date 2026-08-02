package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.PermissionParent;

/**
 * One start time within a {@link ClassStartTimeSet}. `ordinal` numbers the periods within that set,
 * so two sets both legitimately have a "друга пара" — they are simply different rows.
 */
@Data
@GraphQLEntity(table = "class_start_times")
@PermissionParent(value = ClassStartTimeSet.class, joinColumn = "class_start_time_set_id")
public class ClassStartTime {

    private Long id;

    @ManyToOne(joinColumn = "class_start_time_set_id")
    private ClassStartTimeSet classStartTimeSet;

    @Description("Pair ordinal within a day (1..N), unique within its set")
    private Integer ordinal;

    @Description("Start time, e.g. 08:30")
    private String startTime;
}
