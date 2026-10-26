create temporary table class_merge on commit drop as
select c.class_section_id as old_id, k.class_section_id as keep_id
from class_sections c
join (select distinct on (academic_year_id, grade) academic_year_id, grade, class_section_id
      from class_sections order by academic_year_id, grade, created_at, class_section_id) k using (academic_year_id, grade)
where c.class_section_id <> k.class_section_id;

insert into events (event_id, event_type, version, aggregate_id, aggregate_version, occurred_at, correlation_id, causation_id, issued_by, payload)
select gen_random_uuid(), 'admissions.StudentClassChanged', 1, e.enrollment_id,
  (select max(v.aggregate_version) + 1 from events v where v.aggregate_id = e.enrollment_id),
  now(), gen_random_uuid(), gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
  jsonb_build_object('enrollmentId', e.enrollment_id, 'studentId', e.student_id, 'academicYearId', e.academic_year_id,
    'classId', m.keep_id, 'previousClassId', m.old_id)
from enrollments e join class_merge m on m.old_id = e.class_section_id;

update enrollments e set class_section_id = m.keep_id from class_merge m where e.class_section_id = m.old_id;

insert into events (event_id, event_type, version, aggregate_id, aggregate_version, occurred_at, correlation_id, causation_id, issued_by, payload)
select gen_random_uuid(), 'admissions.ClassClosed', 1, c.class_section_id,
  (select max(v.aggregate_version) + 1 from events v where v.aggregate_id = c.class_section_id),
  now(), gen_random_uuid(), gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
  jsonb_build_object('classId', c.class_section_id, 'academicYearId', c.academic_year_id, 'grade', c.grade)
from class_sections c join class_merge m on m.old_id = c.class_section_id;

delete from class_sections where class_section_id in (select old_id from class_merge);

alter table class_sections rename to classes;
alter table classes rename column class_section_id to class_id;
alter table classes drop column section;
alter table classes rename constraint class_sections_pkey to classes_pkey;
alter table classes rename constraint class_sections_year_fk to classes_year_fk;
alter table classes drop constraint class_sections_grade_known;
alter table classes add constraint classes_grade_known check (grade in ('playgroup', 'kg-1', 'kg-2', 'class-1', 'class-2', 'class-3',
  'class-4', 'class-5', 'class-6', 'class-7', 'class-8', 'class-9', 'class-10'));
alter table classes add constraint classes_one_per_grade unique (academic_year_id, grade);
alter table enrollments rename column class_section_id to class_id;
alter table enrollments rename constraint enrollments_section_fk to enrollments_class_fk;
