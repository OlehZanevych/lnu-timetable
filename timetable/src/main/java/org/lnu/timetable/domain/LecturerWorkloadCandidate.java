package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.PermissionParent;

import java.util.List;

/**
 * A lecturer who could deliver a {@link LecturerWorkload}, with how desirable that assignment is.
 * <p>
 * This is the input automatic workload generation works from: rather than considering every
 * lecturer of the department, the generator picks among a workload's candidates and prefers the
 * higher scores. It is deliberately separate from {@code lecturer_workload_lecturers}, which
 * records who was actually assigned — a workload may list several candidates and settle on one.
 */
@Data
@GraphQLEntity(table = "lecturer_workload_candidates")
@PermissionParent(value = LecturerWorkload.class, joinColumn = "lecturer_workload_id")
public class LecturerWorkloadCandidate {

    private Long id;

    @Description("How desirable this lecturer is for the workload: 100 = ideal, 1 = last resort")
    private Integer desirability;

    @ManyToOne(joinColumn = "lecturer_workload_id")
    private LecturerWorkload lecturerWorkload;

    @ManyToOne(joinColumn = "lecturer_id")
    private Lecturer lecturer;

    /**
     * Student-count limits for this candidate — only meaningful for INDIVIDUALLY-taught items.
     * Empty for everything else.
     */
    @OneToMany(mappedBy = "lecturer_workload_candidate_id")
    private List<LecturerWorkloadCandidateConstraint> constraints;
}
