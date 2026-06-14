-- Add react_flow_json column to projects
alter table public.projects 
add column react_flow_json jsonb;
