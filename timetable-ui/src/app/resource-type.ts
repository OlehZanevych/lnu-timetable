/**
 * Converts a GraphQL entity type name (e.g. "WorkingCurriculumItem") to the
 * `permissions.resource_type` identifier the backend uses for it (e.g. "WORKING_CURRICULUM_ITEM")
 * — see `EntityMetadata#resourceType()` / `EntityMetadataRegistry#buildMetadata` on the backend,
 * which derives it the same way from the entity class's simple name.
 */
export const toResourceType = (entityName: string): string =>
  entityName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
