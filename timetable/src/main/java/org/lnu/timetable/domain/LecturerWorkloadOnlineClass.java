package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.PermissionParent;
import org.lnu.timetable.framework.annotation.PgEnum;

/**
 * A {@link LecturerWorkload} held online instead of in a place. The row's <em>presence</em> is the
 * fact — its columns only say how to attend — so creating one is what marks the class as online and
 * deleting it is what puts it back in a room.
 *
 * Keyed by the workload itself rather than by a surrogate id: at most one row per workload is the
 * rule, and the primary key is where that rule belongs. This is the entity
 * {@code @GraphQLEntity(key = ...)} exists for — everything else in the framework still addresses
 * it as {@code id}, because the key is projected under that alias.
 */
@Data
@GraphQLEntity(table = "lecturer_workload_online_classes", key = "lecturer_workload_id")
@PermissionParent(value = LecturerWorkload.class, joinColumn = "lecturer_workload_id")
public class LecturerWorkloadOnlineClass {

    /** The key: the workload this describes. Exposed as the type's {@code id}. */
    private Long lecturerWorkloadId;

    @Nullable
    @PgEnum("online_class_platform")
    @Description("ZOOM, MICROSOFT_TEAMS, GOOGLE_MEET, MOODLE, SKYPE, WEBEX, BIGBLUEBUTTON, OTHER; null = online, platform unstated")
    private String platform;

    @Nullable
    @Description("Where to join the class")
    private String meetingUrl;

    @Nullable
    @Description("Anything the two columns above cannot say, e.g. which platform OTHER means")
    private String note;

    @ManyToOne(joinColumn = "lecturer_workload_id")
    private LecturerWorkload lecturerWorkload;
}
