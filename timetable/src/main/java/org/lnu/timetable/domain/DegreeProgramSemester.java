package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.PermissionParent;

/**
 * How long one semester of one degree programme actually lasts, in teaching weeks.
 *
 * <p>The number of weekly classes a розклад has to place is
 * {@code hours ÷ (weeks × class length)}, and the weeks in that division come from the
 * {@code semester_duration_weeks} global property — one number for the whole university. That holds
 * for most of a degree and stops holding at the end of one: the last semester of a master's programme
 * is largely taken up by the final attestation and a work placement, so its teaching runs for fewer
 * weeks than the property claims.
 *
 * <p>A row exists only for a semester whose length <em>differs</em>. A programme with no row for a
 * semester runs it for the global number of weeks, which is what that property is for; filling the
 * table in exhaustively would turn one correctable number into several hundred copies of it.
 *
 * <p>Rows are created, updated and deleted as part of {@code DegreeProgram}'s create/update
 * mutations (the {@code semesters} nested list — see {@code OrganizationSchemaConfig}), the same way
 * {@code CurriculumItemHours} hangs off a {@code CurriculumItem}: the whole set of a programme's
 * semesters is one screen and one «Зберегти», not a mutation per row.
 */
@Data
@GraphQLEntity(table = "degree_program_semesters")
@PermissionParent(value = DegreeProgram.class, joinColumn = "degree_program_id")
public class DegreeProgramSemester {

    private Long id;

    @Description("The semester number as the programme's own curriculum numbers it — not necessarily "
        + "1-based, since a master's programme may continue the bachelor's numbering at 9, 10, 11")
    private Integer semester;

    @Description("Teaching weeks in this semester, replacing the semester_duration_weeks global property")
    private Integer durationWeeks;

    @ManyToOne(joinColumn = "degree_program_id")
    private DegreeProgram degreeProgram;
}
