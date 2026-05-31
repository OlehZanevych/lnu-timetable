package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;

@Data
@GraphQLEntity(table = "time_slots")
public class TimeSlot {

    private Long id;

    @Description("Pair ordinal within a day (1..N)")
    private Integer ordinal;

    @Description("Start time, e.g. 08:30")
    private String startTime;

    @Description("End time, e.g. 09:50")
    private String endTime;
}
