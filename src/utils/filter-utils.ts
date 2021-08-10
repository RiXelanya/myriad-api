import {Filter, Where} from '@loopback/repository';
import {StatusType} from '../enums';
import {Person, Tag} from '../interfaces';

export function noneStatusFiltering(data: Tag[] | Person[]): string[] {
  return data
    .filter(e => {
      if (e.status === StatusType.NONE || !e.status) return true;
      return false;
    })
    .map(e => e.id);
}

export function defaultFilterQuery(pageNumber = 1, filter?: Filter, where?: Where): Filter {
  let itemsPerPage = 5;

  if (!filter) {
    return {
      limit: itemsPerPage,
      skip: (pageNumber - 1) * itemsPerPage,
    };
  }

  if (filter.limit) itemsPerPage = filter.limit;
  if (where) filter.where = where;

  filter.skip = itemsPerPage * (pageNumber - 1);
  filter.limit = itemsPerPage;

  return filter;
}