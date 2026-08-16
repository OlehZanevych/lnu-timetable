package org.lnu.timetable.framework.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Declares that this entity sits at the top of the permission hierarchy on purpose: nothing above it
 * can be granted, so only a university-wide ({@code GLOBAL}) grant reaches it.
 * <p>
 * Until this existed, "top of the hierarchy" and "somebody forgot to declare the parent" were the
 * same state — the absence of a {@link PermissionParent} — and the two have opposite consequences.
 * A missing edge on {@code Room} would not fail anything at startup or in a test; it would quietly
 * take that entity out of every faculty's cascade, and the deanery who could no longer edit their own
 * аудиторії would be the ones to discover it. {@link EntityMetadataRegistry} now refuses to start
 * unless every {@code @GraphQLEntity} says which of the two it is, so the answer is written down by
 * whoever knows it rather than inferred later by whoever is debugging.
 * <p>
 * Two entities carry it today — {@code Building} and {@code AcademicDegree} — and both are genuinely
 * university-wide objects: a корпус belongs to no faculty, and a науковий ступінь is defined by the
 * state rather than by anyone here.
 *
 * @see PermissionParent
 * @see PermissionJoinParent
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface PermissionRoot {

    /**
     * Why this entity has no owner, for whoever reads the annotation next. Optional, and worth
     * writing: "a корпус belongs to the university, not to a faculty" is the sentence that stops the
     * next person from adding a {@code faculty_id} edge that seems to be missing.
     */
    String value() default "";
}
