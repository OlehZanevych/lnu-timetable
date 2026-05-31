package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToMany;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;

import java.util.List;

@Data
@GraphQLEntity(table = "academic_groups")
public class AcademicGroup {

    private Long id;

    @Description("Group code, e.g. ПМі-31")
    private String name;

    @Description("Year of study (рік навчання), 1..6")
    private Integer courseYear;

    @Description("Study form: FULL_TIME or PART_TIME")
    private String studyForm;

    @Nullable
    private Integer studentsCount;

    @ManyToOne(joinColumn = "specialty_id")
    private Specialty specialty;

    @OneToMany(mappedBy = "academic_group_id")
    private List<Student> students;

    @ManyToMany(joinTable = "combined_group_academic_groups",
        joinColumn = "academic_group_id", inverseJoinColumn = "combined_group_id")
    private List<CombinedGroup> combinedGroups;
}
